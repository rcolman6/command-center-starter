import { NextResponse } from 'next/server';
import { getTask, updateTask, deleteTask } from '@/lib/data';
import { onTaskCompleted } from '@/lib/pipeline-engine';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(task);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const updates = await req.json();
  const t = await updateTask(id, updates);
  if (!t) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (t && t.status === 'completed') {
    await onTaskCompleted(t).catch(() => {}); // pipeline hook — never break the API response
  }
  return NextResponse.json(t);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = await deleteTask(id);
  if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
