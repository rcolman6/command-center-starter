import { promises as fs } from 'fs';
import path from 'path';

const locks = new Map<string, Promise<unknown>>();

export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  const ours = prev.then(() => next);   // queue behind the current holder
  locks.set(key, ours);                 // publish our tail so the next caller waits on us
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (locks.get(key) === ours) locks.delete(key); // GC when no one queued behind us
  }
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  try {
    await fs.rename(tmp, filePath);     // rename is atomic on the same filesystem
  } catch (err) {
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}
