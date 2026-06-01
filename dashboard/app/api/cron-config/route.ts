import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { installCron, removeCron } from '@/lib/cron';

const CFG = path.join(process.cwd(), 'data', 'cron-config.json');

async function read() {
  return JSON.parse(await fs.readFile(CFG, 'utf8'));
}

export async function GET() {
  return NextResponse.json(await read());
}

export async function PUT(req: Request) {
  const prev = await read();
  const body = await req.json(); // { enabled, intervalMinutes }

  const next = {
    ...prev,
    enabled: body.enabled ?? prev.enabled,
    intervalMinutes: body.intervalMinutes ?? prev.intervalMinutes,
  };
  // Worker-owned keys (lastRun/lastTaskId) are never touched here.
  await fs.writeFile(CFG, JSON.stringify(next, null, 2));

  // Reconcile the real crontab with the new desired state.
  const turnedOn      = next.enabled && !prev.enabled;
  const intervalMoved = next.enabled && next.intervalMinutes !== prev.intervalMinutes;
  const turnedOff     = !next.enabled && prev.enabled;

  if (turnedOff)                      await removeCron();
  else if (turnedOn || intervalMoved) await installCron(next.intervalMinutes);

  return NextResponse.json(next);
}
