// dashboard/lib/pipeline-engine.ts
// THE only code that evaluates gates and seeds next-stage tasks.
// The worker never progresses pipelines — the dashboard's task-update API calls
// this engine when a task reaches `completed`. Two owners, no overlap: the script
// owns task status, the engine owns progression. Every timestamp here is
// server-stamped (run/child/event); client input is never trusted.
import { execSync } from 'child_process';
import path from 'path';
import { createTask, updateTask, getTask } from '@/lib/data';
import type { Task } from '@/lib/types';
import { loadPipeline } from '@/lib/pipelines';
import type { PipelineDef, Stage } from '@/lib/pipelines';
import {
  createRun,
  getRun,
  setStage,
  appendEvent,
  updateRun,
} from '@/lib/pipeline-runs';
import type {
  PipelineRun,
  StageState,
  StageStatus,
  RunStatus,
  PipelineEventType,
} from '@/lib/pipeline-runs';

// Repo root from the dashboard cwd. Gate commands run here; ${TASK_ID} resolves
// to the parent task's id.
const REPO_ROOT = path.join(process.cwd(), '..');

// ---------------------------------------------------------------------------
// Single entry point the tasks PATCH route calls on every completed task.
// Decides approve-vs-stage-complete inside the engine so the route stays dumb.
// ---------------------------------------------------------------------------
export async function onTaskCompleted(task: Task): Promise<void> {
  if (!task.pipelineRunId || !task.pipelineId) return; // not a pipeline task — ignore

  const def = loadPipeline(task.pipelineId);
  const stage = def.stages.find((s) => s.id === task.pipelineStage);
  if (!stage) return;

  if (stage.gate.type === 'review') {
    await onApprove(task);
  } else {
    await onStageComplete(task);
  }
}

// ---------------------------------------------------------------------------
// onStageComplete — runs when an auto/test stage's task completes.
// ---------------------------------------------------------------------------
export async function onStageComplete(task: Task): Promise<void> {
  if (!task.pipelineRunId || !task.pipelineId) return; // not a pipeline task — ignore

  const def = loadPipeline(task.pipelineId); // read config/pipelines/<id>.json
  const stage = def.stages.find((s) => s.id === task.pipelineStage);
  if (!stage) return;

  switch (stage.gate.type) {
    case 'auto': {
      await recordEvent(task, stage.id, 'gate_passed');
      await setStageState(task, stage.id, 'completed');
      await seedNext(task, def, stage); // seed `next`, or complete the run if terminal
      break;
    }

    case 'test': {
      const code = runShell(resolveCommand(stage.gate.command, task)); // exit 0 = pass
      if (code === 0) {
        await recordEvent(task, stage.id, 'gate_passed');
        await setStageState(task, stage.id, 'completed');
        await seedNext(task, def, stage);
      } else {
        const st = await getStageState(task, stage.id);
        const healAttempts = st?.healAttempts ?? 0;
        await recordEvent(task, stage.id, 'gate_failed', `exit ${code}`);
        if (healAttempts >= stage.gate.onFail.maxRetries) {
          await setStageState(task, stage.id, 'failed', {
            lastError: `exit ${code}`,
          });
          await setRunStatus(task, 'failed');
          await recordEvent(
            task,
            stage.id,
            'escalated',
            stage.gate.onFail.thenEscalate,
          );
          // thenEscalate === 'review' → Captain inspects the parent task.
          await updateTask(task.id, {
            status: 'needs_review',
            claudeNotes: `Test gate failed after ${stage.gate.onFail.maxRetries} heal attempt(s). Last gate exit: ${code}.`,
          });
        } else {
          // increment BEFORE seeding the heal
          await setStageState(task, stage.id, 'healing', {
            healAttempts: healAttempts + 1,
            lastError: `exit ${code}`,
          });
          await setRunStatus(task, 'healing');
          await recordEvent(
            task,
            stage.id,
            'heal_triggered',
            stage.gate.onFail.heal,
          );
          // Re-tests the SAME stage on completion: the heal task keeps this
          // stage's id and autoMode=true, so it auto-completes and re-triggers
          // the test gate. Stage status stays 'healing' (set just above).
          await seedChildTask(task.pipelineRunId!, def, stage.id, {
            command: stage.gate.onFail.heal,
            autoMode: true,
            isHeal: true,
          });
        }
      }
      break;
    }

    case 'review':
      // No-op. The worker already shipped needs_review; wait for the Captain.
      return;
  }
}

// ---------------------------------------------------------------------------
// onApprove — runs when the Captain approves a needs_review review-gate task.
// ---------------------------------------------------------------------------
export async function onApprove(task: Task): Promise<void> {
  if (!task.pipelineRunId || !task.pipelineId) return;
  const def = loadPipeline(task.pipelineId);
  const stage = def.stages.find((s) => s.id === task.pipelineStage);
  if (!stage || stage.gate.type !== 'review') return;

  await recordEvent(task, stage.id, 'approved');
  await setStageState(task, stage.id, 'completed');
  await seedNext(task, def, stage); // seed `next`, or complete the run if terminal
}

// ---------------------------------------------------------------------------
// createRunAndSeedFirst — used by the manual Run button and the cron trigger.
// Creates a run and seeds the first stage's task.
// ---------------------------------------------------------------------------
export async function createRunAndSeedFirst(
  pipelineId: string,
  trigger: { type: 'cron' | 'manual'; source?: string },
  input?: string, // optional per-run prompt, woven into the first stage's task
): Promise<PipelineRun> {
  const def = loadPipeline(pipelineId); // throws if unknown — caller maps to 400/404
  const run = await createRun({
    pipelineId: def.id,
    pipelineSlug: def.name,
    trigger,
  });

  const first = def.stages[0];
  // First stage: autoMode by its own gate. Mark the stage running, seed the
  // task, then set the run status (review → awaiting_review, else running).
  // The run input (if any) only seeds the FIRST stage — it is the run's WHAT;
  // downstream stages receive the prior stage's deliverable via prevOutput.
  await markStageRunning(run.id, first.id);
  await seedChildTask(run.id, def, first.id, {
    command: first.command,
    autoMode: first.gate.type !== 'review',
    input,
  });
  await applyRunStatusForStage(run.id, first);

  return (await getRun(run.id)) ?? run;
}

// ---------------------------------------------------------------------------
// seedNext — follow stage.next; if none, the stage is terminal → complete run.
// ---------------------------------------------------------------------------
async function seedNext(
  task: Task,
  def: PipelineDef,
  stage: Stage,
): Promise<void> {
  if (stage.next) {
    const nextStage = def.stages.find((s) => s.id === stage.next);
    if (!nextStage) return; // schema guarantees this, but stay defensive
    // autoMode is decided by the NEW stage's gate: auto/test → true, review → false.
    // Hand the just-finished stage's deliverable to the next stage. The worker
    // derives completionFile from the filesystem, so this is fully deterministic
    // and needs nothing special from the agent — it just consumes the input.
    await markStageRunning(task.pipelineRunId!, nextStage.id);
    await seedChildTask(task.pipelineRunId!, def, nextStage.id, {
      command: nextStage.command,
      autoMode: nextStage.gate.type !== 'review',
      prevOutput: task.completionFile ?? null,
    });
    await applyRunStatusForStage(task.pipelineRunId!, nextStage);
  } else {
    // Terminal stage — the run is done.
    await recordEvent(task, stage.id, 'completed');
    await setRunStatus(task, 'completed');
  }
}

// ---------------------------------------------------------------------------
// resolveStageInputs — turn a stage's declared `inputs` (upstream stage ids)
// into a { stageId: deliverablePath } map by reading each named stage's
// most-recent completed task off the run record. Stages with no `inputs` get an
// empty map; the default previous-stage handoff (prevOutput) is independent and
// unchanged. Fully script-derived: the consuming agent reports nothing, it just
// reads the paths handed to it.
// ---------------------------------------------------------------------------
async function resolveStageInputs(
  runId: string,
  def: PipelineDef,
  stageId: string,
): Promise<Record<string, string>> {
  const stage = def.stages.find((s) => s.id === stageId);
  if (!stage?.inputs?.length) return {};
  const run = await getRun(runId);
  if (!run) return {};
  const resolved: Record<string, string> = {};
  for (const upstreamId of stage.inputs) {
    const st = run.stageState[upstreamId];
    if (!st) continue;
    // taskIds are in seed order (incl. heals); the final deliverable is the
    // last task for that stage that produced a completionFile.
    let file: string | null = null;
    for (const tid of st.taskIds) {
      const t = await getTask(tid);
      if (t?.completionFile) file = t.completionFile;
    }
    if (file) resolved[upstreamId] = file;
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// seedChildTask — the single low-level seeder. Creates the child task with the
// pipeline join stamped, appends its id to the stage's taskIds, and records the
// seeding event. Does NOT set run/stage status — callers own that, because the
// heal path must keep the stage 'healing' while a next-stage seed marks it
// 'running'. For a heal task the pipelineStage stays the SAME stage id and
// autoMode=true (so it auto-completes and re-triggers the test gate).
// ---------------------------------------------------------------------------
async function seedChildTask(
  runId: string,
  def: PipelineDef,
  stageId: string,
  opts: {
    command: string;
    autoMode: boolean;
    isHeal?: boolean;
    prevOutput?: string | null; // prior stage's deliverable, handed forward
    input?: string; // per-run prompt; only the first stage receives it
  },
): Promise<void> {
  const stage = def.stages.find((s) => s.id === stageId);
  const label = stage?.label ?? stageId;
  const title = opts.isHeal
    ? `[${def.name}] heal: ${label}`
    : `[${def.name}] ${label}`;
  let description = opts.isHeal
    ? `Heal task for stage "${stageId}" of pipeline "${def.id}". Fix the output so the test gate passes; the gate re-runs when this task completes.`
    : `Pipeline "${def.id}" — stage "${stageId}".`;
  // Weave the run input into the description so the worker (which builds the
  // prompt from the task's description) hands it straight to the agent. This is
  // the run's WHAT; it only ever reaches the first stage.
  const runInput = opts.input?.trim();
  if (runInput) {
    description += `\n\n## Run input\n${runInput}`;
  }
  // Hand the immediately-preceding stage's deliverable to this stage, both in
  // prose (what the agent reads) and in metadata (programmatic). Script-derived,
  // so it always points at a real file without the upstream agent having to
  // report anything. This is the DEFAULT handoff, unchanged.
  if (opts.prevOutput) {
    description += `\n\nPrevious stage output: ${opts.prevOutput}`;
  }

  // Data flow: resolve this stage's explicitly declared `inputs` to the
  // deliverable each named upstream stage produced, and hand them forward by
  // name. Lets a stage read ANY earlier stage's output, not just the previous
  // one. Also fully script-derived — the consuming agent reports nothing.
  const inputs = await resolveStageInputs(runId, def, stageId);
  const inputIds = Object.keys(inputs);
  if (inputIds.length) {
    description +=
      `\n\nInputs from prior stages:\n` +
      inputIds.map((id) => `- ${id}: ${inputs[id]}`).join('\n');
  }

  const child = await createTask({
    title,
    description,
    status: 'pending',
    slashCommand: opts.command,
    model: 'sonnet',
    pipelineId: def.id,
    pipelineRunId: runId,
    pipelineStage: stageId,
    metadata: {
      autoMode: opts.autoMode,
      ...(runInput ? { runInput } : {}),
      ...(opts.prevOutput ? { previousCompletionFile: opts.prevOutput } : {}),
      ...(inputIds.length ? { inputs } : {}),
    },
  });

  // Append the child id to the stage's taskIds (preserve status/heal/error).
  const run = await getRun(runId);
  const existing: StageState | undefined = run?.stageState[stageId];
  const nextState: StageState = {
    status: existing?.status ?? 'running',
    taskIds: [...(existing?.taskIds ?? []), child.id],
    healAttempts: existing?.healAttempts ?? 0,
  };
  if (existing?.lastError !== undefined) nextState.lastError = existing.lastError;
  await setStage(runId, stageId, nextState);

  // Record the seeding event. The heal path already emitted 'heal_triggered'
  // for the gate decision, so the heal task's own seed is a plain 'started'
  // carrying the new task id.
  await appendEvent(runId, {
    stage: stageId,
    type: 'started',
    taskId: child.id,
  });
}

// Mark a stage 'running' without disturbing its taskIds/healAttempts/lastError.
async function markStageRunning(runId: string, stageId: string): Promise<void> {
  const run = await getRun(runId);
  const existing: StageState | undefined = run?.stageState[stageId];
  const nextState: StageState = {
    status: 'running',
    taskIds: existing?.taskIds ?? [],
    healAttempts: existing?.healAttempts ?? 0,
  };
  if (existing?.lastError !== undefined) nextState.lastError = existing.lastError;
  await setStage(runId, stageId, nextState);
}

// ---------------------------------------------------------------------------
// Stage-state + event + run-status helpers (all operate on the task's run).
// ---------------------------------------------------------------------------
async function setStageState(
  task: Task,
  stageId: string,
  status: StageStatus,
  patch?: Partial<Pick<StageState, 'healAttempts' | 'lastError' | 'taskIds'>>,
): Promise<void> {
  const run = await getRun(task.pipelineRunId!);
  const existing: StageState | undefined = run?.stageState[stageId];
  const next: StageState = {
    status,
    taskIds: patch?.taskIds ?? existing?.taskIds ?? [],
    healAttempts: patch?.healAttempts ?? existing?.healAttempts ?? 0,
  };
  const lastError = patch?.lastError ?? existing?.lastError;
  if (lastError !== undefined) next.lastError = lastError;
  await setStage(task.pipelineRunId!, stageId, next);
}

async function getStageState(
  task: Task,
  stageId: string,
): Promise<StageState | undefined> {
  const run = await getRun(task.pipelineRunId!);
  return run?.stageState[stageId];
}

async function recordEvent(
  task: Task,
  stageId: string,
  type: PipelineEventType,
  detail?: string,
): Promise<void> {
  await appendEvent(task.pipelineRunId!, {
    stage: stageId,
    type,
    taskId: task.id,
    ...(detail !== undefined ? { detail } : {}),
  });
}

async function setRunStatus(task: Task, status: RunStatus): Promise<void> {
  await setRunStatusById(task.pipelineRunId!, status);
}

async function setRunStatusById(
  runId: string,
  status: RunStatus,
): Promise<void> {
  const updates: Partial<Omit<PipelineRun, 'id' | 'startedAt'>> = { status };
  if (status === 'completed') {
    updates.completedAt = new Date().toISOString(); // server-stamped
  }
  await updateRun(runId, updates);
}

// Map a newly seeded stage to the run status: review gate → awaiting_review,
// anything else keeps the run running. (healing/failed/completed are set on the
// gate-evaluation paths above.)
async function applyRunStatusForStage(
  runId: string,
  stage: Stage,
): Promise<void> {
  if (stage.gate.type === 'review') {
    await setRunStatusById(runId, 'awaiting_review');
  } else {
    await setRunStatusById(runId, 'running');
  }
}

// ---------------------------------------------------------------------------
// runShell — run a test-gate command at the repo root; return its exit code.
// exit 0 = pass. Never throws; a non-zero exit is data, not an error.
// ---------------------------------------------------------------------------
function runShell(command: string): number {
  try {
    execSync(command, { cwd: REPO_ROOT, stdio: 'ignore' });
    return 0;
  } catch (err: unknown) {
    const status = (err as { status?: number } | null)?.status;
    return typeof status === 'number' ? status : 1;
  }
}

// Substitute ${TASK_ID} in a gate command with the parent task's id.
function resolveCommand(command: string, task: Task): string {
  return command.split('${TASK_ID}').join(task.id);
}
