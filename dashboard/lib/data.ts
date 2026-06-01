import { promises as fs } from 'fs';
import path from 'path';
import { Task } from './types';
import { generateId } from './utils';            // "task-{timestamp}-{random}"
import { withFileLock, atomicWriteJson } from './file-mutex';

const DATA_DIR = path.join(process.cwd(), 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

export async function getTasks(): Promise<Task[]> {
  try {
    return JSON.parse(await fs.readFile(TASKS_FILE, 'utf-8'));
  } catch {
    return []; // missing file = empty queue
  }
}

export async function getTask(id: string): Promise<Task | null> {
  return (await getTasks()).find((t) => t.id === id) ?? null;
}

export async function createTask(input: Partial<Task>): Promise<Task> {
  const now = new Date().toISOString();
  const task: Task = {
    id: generateId(),
    title: input.title ?? 'Untitled Task',
    description: input.description ?? '',
    status: input.status ?? 'pending',
    priority: input.priority ?? 3,
    engine: input.engine ?? 'claude',
    model: input.model ?? 'sonnet',
    slashCommand: input.slashCommand ?? null,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    parentTaskId: input.parentTaskId ?? null,
    claudeNotes: input.claudeNotes ?? '',
    completionFile: input.completionFile ?? null,
    claudeSessionId: input.claudeSessionId ?? null,
    captainNotes: input.captainNotes ?? null,
    metadata: input.metadata ?? null,
    pipelineId: input.pipelineId ?? null,
    pipelineRunId: input.pipelineRunId ?? null,
    pipelineStage: input.pipelineStage ?? null,
    createdAt: now,
    updatedAt: now,
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
  };
  await withFileLock(TASKS_FILE, async () => {
    const tasks = await getTasks();
    tasks.push(task);
    await atomicWriteJson(TASKS_FILE, tasks);
  });
  return task;
}

export async function updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
  return withFileLock(TASKS_FILE, async () => {
    const tasks = await getTasks();
    const i = tasks.findIndex((t) => t.id === id);
    if (i === -1) return null;
    const prev = tasks[i];

    // MERGE metadata — never replace. Callers PATCH only the keys they own,
    // so accumulate (a card branch + a worker promptSnapshot must coexist).
    const metadata =
      updates.metadata !== undefined
        ? { ...(prev.metadata ?? {}), ...(updates.metadata ?? {}) }
        : prev.metadata;

    const now = new Date().toISOString();
    const next: Task = {
      ...prev, ...updates, metadata,
      id: prev.id,                 // never overwrite
      createdAt: prev.createdAt,   // never overwrite
      updatedAt: now,
      // stamp lifecycle timestamps on the transitions that produce them
      startedAt: updates.status === 'in_progress' && !prev.startedAt ? now : prev.startedAt,
      completedAt: updates.status === 'completed' ? now : prev.completedAt,
    };

    tasks[i] = next;
    await atomicWriteJson(TASKS_FILE, tasks);
    return next;
  });
}

export async function deleteTask(id: string): Promise<boolean> {
  return withFileLock(TASKS_FILE, async () => {
    const tasks = await getTasks();
    const kept = tasks.filter((t) => t.id !== id);
    if (kept.length === tasks.length) return false;
    await atomicWriteJson(TASKS_FILE, kept);
    return true;
  });
}
