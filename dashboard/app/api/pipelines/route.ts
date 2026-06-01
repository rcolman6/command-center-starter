import { NextResponse } from 'next/server';
import { listPipelines } from '@/lib/pipelines';

// GET /api/pipelines — derive the list at runtime by reading config/pipelines/*.json.
// There is no hand-maintained registry constant. Never throws on an empty/missing dir.
export async function GET() {
  try {
    return NextResponse.json(listPipelines());
  } catch {
    return NextResponse.json([]);
  }
}
