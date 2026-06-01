import { NextResponse } from 'next/server';
import { getTasks, createTask } from '@/lib/data';

export async function GET() {
  const tasks = await getTasks();
  tasks.sort((a, b) =>
    a.priority !== b.priority
      ? a.priority - b.priority                                   // priority ascending
      : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()); // then newest first
  return NextResponse.json(tasks);
}

export async function POST(req: Request) {
  const input = await req.json();
  const task = await createTask(input); // server fills all defaults
  return NextResponse.json(task, { status: 201 });
}
