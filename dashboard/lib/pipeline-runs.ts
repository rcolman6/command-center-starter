// dashboard/lib/pipeline-runs.ts
// The data accessor for pipeline run records (dashboard/data/pipeline-runs.json).
// One execution of a pipeline definition is one PipelineRun. Server-stamps every
// timestamp; never trusts client input for `startedAt`, `completedAt`, or `event.ts`.
import { promises as fs } from 'fs';
import path from 'path';
import { withFileLock, atomicWriteJson } from './file-mutex';

export type RunStatus =
  | 'running'
  | 'awaiting_review'
  | 'healing'
  | 'failed'
  | 'completed';

export type StageStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'healing'
  | 'failed';

export interface StageState {
  status: StageStatus;
  taskIds: string[]; // every task seeded for this stage (incl. heal tasks)
  healAttempts: number;
  lastError?: string;
}

export type PipelineEventType =
  | 'started'
  | 'gate_passed'
  | 'gate_failed'
  | 'heal_triggered'
  | 'approved'
  | 'escalated'
  | 'completed';

export interface PipelineEvent {
  ts: string; // ISO, ALWAYS server-stamped
  stage: string;
  type: PipelineEventType;
  detail?: string;
  taskId?: string;
}

export interface PipelineRun {
  id: string; // "run-{timestamp}-{random}"
  pipelineId: string; // which definition (config/pipelines/<id>.json)
  pipelineSlug: string; // human-readable instance label for this run
  status: RunStatus;
  startedAt: string; // ISO, server-stamped
  completedAt: string | null;
  trigger: { type: 'cron' | 'manual'; source?: string };
  stageState: Record<string, StageState>;
  events: PipelineEvent[];
}

const DATA_DIR = path.join(process.cwd(), 'data');
const RUNS_FILE = path.join(DATA_DIR, 'pipeline-runs.json');

export async function getRuns(): Promise<PipelineRun[]> {
  try {
    return JSON.parse(await fs.readFile(RUNS_FILE, 'utf-8'));
  } catch {
    return []; // missing file = no runs
  }
}

export async function getRun(id: string): Promise<PipelineRun | null> {
  return (await getRuns()).find((r) => r.id === id) ?? null;
}

export interface CreateRunInput {
  pipelineId: string;
  pipelineSlug?: string;
  trigger: { type: 'cron' | 'manual'; source?: string };
}

export async function createRun(input: CreateRunInput): Promise<PipelineRun> {
  const now = new Date().toISOString();
  const run: PipelineRun = {
    id: 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    pipelineId: input.pipelineId,
    pipelineSlug: input.pipelineSlug ?? input.pipelineId,
    status: 'running',
    startedAt: now, // server-stamped
    completedAt: null,
    trigger: input.trigger,
    stageState: {},
    events: [],
  };
  await withFileLock(RUNS_FILE, async () => {
    const runs = await getRuns();
    runs.push(run);
    await atomicWriteJson(RUNS_FILE, runs);
  });
  return run;
}

// Patch top-level run fields (status, completedAt, slug…). Never overwrites id
// or startedAt. Use the append helpers below for stageState/events.
export async function updateRun(
  id: string,
  updates: Partial<Omit<PipelineRun, 'id' | 'startedAt'>>,
): Promise<PipelineRun | null> {
  return withFileLock(RUNS_FILE, async () => {
    const runs = await getRuns();
    const i = runs.findIndex((r) => r.id === id);
    if (i === -1) return null;
    const prev = runs[i];
    const next: PipelineRun = {
      ...prev,
      ...updates,
      id: prev.id, // never overwrite
      startedAt: prev.startedAt, // never overwrite
    };
    runs[i] = next;
    await atomicWriteJson(RUNS_FILE, runs);
    return next;
  });
}

// Replace (or create) the state for one stage. Atomic read-modify-write.
export async function setStage(
  runId: string,
  stageId: string,
  state: StageState,
): Promise<PipelineRun | null> {
  return withFileLock(RUNS_FILE, async () => {
    const runs = await getRuns();
    const i = runs.findIndex((r) => r.id === runId);
    if (i === -1) return null;
    runs[i].stageState[stageId] = state;
    await atomicWriteJson(RUNS_FILE, runs);
    return runs[i];
  });
}

// Append-only event log. ALWAYS server-stamps `ts` here; any `ts` on the input
// is ignored, so a client can never forge event time.
export async function appendEvent(
  runId: string,
  event: Omit<PipelineEvent, 'ts'> & { ts?: string },
): Promise<PipelineRun | null> {
  return withFileLock(RUNS_FILE, async () => {
    const runs = await getRuns();
    const i = runs.findIndex((r) => r.id === runId);
    if (i === -1) return null;
    const stamped: PipelineEvent = {
      stage: event.stage,
      type: event.type,
      ...(event.detail !== undefined ? { detail: event.detail } : {}),
      ...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
      ts: new Date().toISOString(), // server-stamped, overrides any client value
    };
    runs[i].events.push(stamped);
    await atomicWriteJson(RUNS_FILE, runs);
    return runs[i];
  });
}
