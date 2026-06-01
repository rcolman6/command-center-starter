import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const MARKER = '# COMMAND-CENTER-WORKER';
// Absolute path to THIS repo. Set it once; it's the one place an abs path is allowed
// in code, because crontab runs with no working directory.
const REPO_DIR = '/home/romij/claude_accessible/command-center';

const WORKER_CMD =
  `cd ${REPO_DIR} && bash workers/run-worker.sh >> workers/logs/cron.log 2>&1`;

/** <60 -> every N min; ==60 -> top of every hour; >60 (mult of 60) -> every H hours. */
export function buildCronExpression(intervalMinutes: number): string {
  return intervalMinutes < 60
    ? `*/${intervalMinutes} * * * *`
    : intervalMinutes === 60
      ? '0 * * * *'
      : `0 */${intervalMinutes / 60} * * *`;
}

/** Read the current crontab. Empty string if none exists (a fresh box has no crontab). */
async function readCrontab(): Promise<string> {
  try {
    const { stdout } = await execAsync('crontab -l 2>/dev/null');
    return stdout;
  } catch {
    return '';
  }
}

/** Write a crontab from a string via `crontab -` (stdin). Empty content removes it. */
async function writeCrontab(content: string): Promise<void> {
  const trimmed = content.trim();
  if (trimmed === '') {
    try { await execAsync('crontab -r 2>/dev/null'); } catch { /* already empty */ }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn('crontab', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(stderr || `crontab exit ${code}`)));
    child.stdin.end(`${trimmed}\n`);
  });
}

/** Install (or replace) our cron line at the given interval. */
export async function installCron(intervalMinutes: number): Promise<void> {
  const current = await readCrontab();
  // Strip any prior COMMAND-CENTER line, keep everything else.
  const lines = current.split('\n').filter((l) => !l.includes(MARKER));
  lines.push(`${buildCronExpression(intervalMinutes)} ${WORKER_CMD} ${MARKER}`);
  await writeCrontab(lines.filter((l) => l.trim() !== '').join('\n'));
}

/** Remove our cron line; leave the rest of the crontab intact. */
export async function removeCron(): Promise<void> {
  const current = await readCrontab();
  const lines = current.split('\n').filter((l) => !l.includes(MARKER));
  await writeCrontab(lines.filter((l) => l.trim() !== '').join('\n'));
}
