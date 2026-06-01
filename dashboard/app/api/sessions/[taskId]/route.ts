import { promises as fs } from 'fs';
import path from 'path';

export async function GET(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const p = path.join(process.cwd(), '..', 'workers', 'workspace', 'sessions', `${taskId}.json`);
  try {
    const raw = await fs.readFile(p, 'utf8');
    return new Response(raw, { headers: { 'content-type': 'application/json' } });
  } catch {
    return new Response(JSON.stringify({ error: 'no session yet' }), { status: 404 });
  }
}
