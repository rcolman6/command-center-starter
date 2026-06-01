import { NextResponse } from 'next/server';
import { getRuns } from '@/lib/pipeline-runs';
import { listPipelines } from '@/lib/pipelines';
import { createRunAndSeedFirst } from '@/lib/pipeline-engine';

// GET /api/pipeline-runs — list runs, newest first.
export async function GET() {
  const runs = await getRuns();
  runs.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
  return NextResponse.json(runs);
}

// POST /api/pipeline-runs — body { pipelineId, input? } → start a manual run.
// `input` is an optional per-run prompt woven into the first stage's task.
// 400 if pipelineId is missing/unknown, or if input is present but not a string.
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const pipelineId =
    body && typeof body === 'object' && 'pipelineId' in body
      ? (body as { pipelineId?: unknown }).pipelineId
      : undefined;

  if (typeof pipelineId !== 'string' || pipelineId.length === 0) {
    return NextResponse.json(
      { error: 'pipelineId is required' },
      { status: 400 },
    );
  }

  const rawInput =
    body && typeof body === 'object' && 'input' in body
      ? (body as { input?: unknown }).input
      : undefined;

  if (rawInput !== undefined && typeof rawInput !== 'string') {
    return NextResponse.json(
      { error: 'input must be a string' },
      { status: 400 },
    );
  }
  // Normalize: empty / whitespace-only input is treated as no input.
  const input = rawInput?.trim() ? rawInput : undefined;

  const known = listPipelines().some((p) => p.id === pipelineId);
  if (!known) {
    return NextResponse.json(
      { error: `unknown pipeline "${pipelineId}"` },
      { status: 400 },
    );
  }

  const run = await createRunAndSeedFirst(
    pipelineId,
    { type: 'manual', source: 'dashboard' },
    input,
  );
  return NextResponse.json(run, { status: 201 });
}
