export type ModelId = 'sonnet' | 'opus' | 'haiku';
export type AgentEngine = 'claude' | 'codex';   // which CLI the worker spawns; defaults to 'claude'
export type TaskStatus = 'pending' | 'in_progress' | 'needs_review' | 'completed';

export interface Task {
  id: string;                         // "task-{timestamp}-{random}"
  title: string;
  description: string;                // what to do, where inputs are
  status: TaskStatus;
  priority: 0 | 1 | 2 | 3 | 4 | 5;    // 0 = above everything; 1 = highest normal; 3 = default
  engine: AgentEngine;                // 'claude' (default) | 'codex' — which CLI the worker runs
  model: ModelId;                     // claude model; defaults to 'sonnet'. Ignored when engine === 'codex'.

  slashCommand: string | null;        // "worker/<name>" — the HOW. Injected into the prompt.
  acceptanceCriteria: string[];       // rendered as checkboxes on the card

  parentTaskId: string | null;        // blocks this task until the parent leaves pending/in_progress

  // --- worker-owned outputs (the agent PATCHes notes/completionFile; the worker owns status) ---
  claudeNotes: string;                // first 500 chars of notes file, or agent-PATCHed summary
  completionFile: string | null;      // repo-relative path to the primary deliverable
  claudeSessionId: string | null;     // captured from the run; used for --resume on revision
  captainNotes: string | null;        // feedback you add on approve/revise

  // --- generic extension point ---
  metadata: Record<string, unknown> | null;
  // Conventions on metadata:
  //   metadata.promptSnapshot         : string        — the exact prompt the worker sent (observability)
  //   metadata.extraOutputs           : {label,path}[] — extra artifacts to surface on the card
  //   metadata.autoMode               : boolean        — if true, worker auto-completes instead of needs_review
  //   metadata.codexModel             : string         — codex model override (engine === 'codex' only); unset → codex config default
  //   metadata.previousCompletionFile : string         — the immediately-preceding stage's deliverable (default pipeline handoff)
  //   metadata.inputs                 : Record<stageId,path> — deliverables of explicitly declared upstream stages (pipeline data flow)

  // --- pipeline join (Layer 2; null for standalone tasks) ---
  pipelineId: string | null;          // which pipeline definition
  pipelineRunId: string | null;       // which run (row in pipeline-runs.json)
  pipelineStage: string | null;       // which stage id

  // --- timestamps ---
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}
