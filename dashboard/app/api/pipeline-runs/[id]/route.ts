import { NextResponse } from 'next/server';
import { getRun } from '@/lib/pipeline-runs';

// GET /api/pipeline-runs/[id] — one run, 404 if unknown.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(run);
}
