import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export async function GET() {
  const dir = path.join(os.homedir(), '.claude', 'commands', 'worker');
  try {
    const entries = await fs.readdir(dir);
    const commands = entries
      .filter((f) => f.endsWith('.md'))
      .map((f) => `worker/${path.basename(f, '.md')}`);
    return NextResponse.json(commands);
  } catch {
    return NextResponse.json([]); // dir missing or unreadable — empty list, never throw
  }
}
