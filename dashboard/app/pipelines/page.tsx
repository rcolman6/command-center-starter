'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PipelineDef, Stage, Gate } from '@/lib/pipelines';
import type { PipelineRun, StageState } from '@/lib/pipeline-runs';

const POLL_MS = 10_000;

// ---- run status badge colors -------------------------------------------------
const RUN_BADGE: Record<PipelineRun['status'], string> = {
  running: 'bg-blue-100 text-blue-800',
  awaiting_review: 'bg-amber-100 text-amber-800',
  healing: 'bg-purple-100 text-purple-800',
  failed: 'bg-red-100 text-red-800',
  completed: 'bg-green-100 text-green-800',
};

const STAGE_BADGE: Record<StageState['status'], string> = {
  pending: 'bg-gray-100 text-gray-700',
  running: 'bg-blue-100 text-blue-800',
  completed: 'bg-green-100 text-green-800',
  healing: 'bg-purple-100 text-purple-800',
  failed: 'bg-red-100 text-red-800',
};

function gateLabel(gate: Gate): string {
  switch (gate.type) {
    case 'auto':
      return 'auto';
    case 'review':
      return 'review';
    case 'test':
      return `test (heal ${gate.onFail.heal}, ≤${gate.onFail.maxRetries})`;
  }
}

function fmt(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

// Data flow per stage: the upstream deliverables it reads. A stage with declared
// `inputs` reads exactly those (explicit); a stage without reads the
// immediately-preceding stage in the chain (the default handoff). `next` is
// control flow — what runs next; this is data flow — what each stage consumes.
function dataSources(
  p: PipelineDef,
): { stage: Stage; sources: string[]; declared: boolean }[] {
  const predecessor = new Map<string, string>(); // stageId ← stage whose `next` points at it
  for (const s of p.stages) if (s.next) predecessor.set(s.next, s.id);
  return p.stages.map((s) => {
    const declared = s.inputs !== undefined;
    const sources = declared
      ? (s.inputs as string[])
      : predecessor.has(s.id)
        ? [predecessor.get(s.id)!]
        : [];
    return { stage: s, sources, declared };
  });
}

export default function PipelinesPage() {
  const [pipelines, setPipelines] = useState<PipelineDef[]>([]);
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [composing, setComposing] = useState<string | null>(null); // pipeline id with an open composer
  const [inputText, setInputText] = useState('');

  const load = useCallback(async () => {
    try {
      const [pRes, rRes] = await Promise.all([
        fetch('/api/pipelines'),
        fetch('/api/pipeline-runs'),
      ]);
      if (pRes.ok) setPipelines(await pRes.json());
      if (rRes.ok) setRuns(await rRes.json());
      setError(null);
    } catch {
      setError('Failed to load pipelines.');
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function runPipeline(id: string, input: string) {
    setBusy(id);
    try {
      const trimmed = input.trim();
      const res = await fetch('/api/pipeline-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pipelineId: id,
          ...(trimmed ? { input: trimmed } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Failed to start "${id}".`);
      } else {
        setComposing(null);
        setInputText('');
        await load();
      }
    } catch {
      setError(`Failed to start "${id}".`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="mb-1 text-2xl font-semibold">Pipelines</h1>
      <p className="mb-6 text-sm text-gray-500">
        Definitions live in <code>config/pipelines/*.json</code>. The engine
        seeds each stage&apos;s task and evaluates its gate.
      </p>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ---- definitions ---- */}
      <section className="mb-10">
        <h2 className="mb-3 text-lg font-medium">Definitions</h2>
        {pipelines.length === 0 ? (
          <p className="text-sm text-gray-500">
            No pipelines yet. Author one with <code>/setup-pipeline</code>.
          </p>
        ) : (
          <ul className="space-y-4">
            {pipelines.map((p) => (
              <li key={p.id} className="rounded-lg border border-gray-200 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-gray-500">{p.id}</div>
                    {p.description && (
                      <p className="mt-1 text-sm text-gray-600">
                        {p.description}
                      </p>
                    )}
                    <div className="mt-2 text-xs text-gray-500">
                      trigger:{' '}
                      <span className="font-mono">
                        {p.trigger.type}
                        {p.trigger.type === 'cron' && p.trigger.cron
                          ? ` (${p.trigger.cron})`
                          : ''}
                      </span>
                    </div>
                  </div>
                  {p.trigger.type === 'manual' && (
                    <button
                      onClick={() => {
                        setError(null);
                        setInputText('');
                        setComposing((cur) => (cur === p.id ? null : p.id));
                      }}
                      disabled={busy === p.id}
                      className="shrink-0 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {busy === p.id
                        ? 'Starting…'
                        : composing === p.id
                          ? 'Cancel'
                          : 'Run'}
                    </button>
                  )}
                </div>

                {/* run composer — type a prompt that seeds the first stage */}
                {p.trigger.type === 'manual' && composing === p.id && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      runPipeline(p.id, inputText);
                    }}
                    className="mt-3 rounded border border-gray-200 bg-gray-50 p-3"
                  >
                    <label className="block text-xs font-medium text-gray-600">
                      Prompt for this run{' '}
                      <span className="font-normal text-gray-400">
                        (optional — handed to the first stage)
                      </span>
                    </label>
                    <textarea
                      autoFocus
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      rows={3}
                      placeholder="What this run should work on — a topic, a link, specific instructions…"
                      className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                    />
                    <div className="mt-2 flex gap-2">
                      <button
                        type="submit"
                        disabled={busy === p.id}
                        className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {busy === p.id ? 'Starting…' : 'Start run'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setComposing(null);
                          setInputText('');
                        }}
                        className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                {/* stage → gate → next chain */}
                <ol className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  {p.stages.map((s: Stage, i: number) => (
                    <li key={s.id} className="flex items-center gap-2">
                      <span className="rounded border border-gray-300 bg-gray-50 px-2 py-1">
                        <span className="font-medium">{s.label ?? s.id}</span>
                        <span className="ml-1 text-gray-500">
                          [{gateLabel(s.gate)}]
                        </span>
                      </span>
                      {s.next ? (
                        <span className="text-gray-400">→</span>
                      ) : (
                        i === p.stages.length - 1 && (
                          <span className="text-gray-400">⊣ end</span>
                        )
                      )}
                    </li>
                  ))}
                </ol>

                {/* data flow — which upstream deliverable each stage reads */}
                {(() => {
                  const flows = dataSources(p).filter(
                    (f) => f.sources.length > 0,
                  );
                  if (flows.length === 0) return null;
                  return (
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                      <span className="font-medium text-gray-600">
                        data flow:
                      </span>
                      {flows.map(({ stage, sources, declared }) => (
                        <span
                          key={stage.id}
                          className={declared ? 'text-gray-700' : 'text-gray-400'}
                          title={
                            declared
                              ? 'explicit inputs declared on this stage'
                              : 'default handoff from the preceding stage'
                          }
                        >
                          <span className="font-mono">
                            {sources.join(' + ')}
                          </span>
                          <span className="mx-1">→</span>
                          <span className="font-mono">
                            {stage.label ?? stage.id}
                          </span>
                          {!declared && (
                            <span className="ml-1 text-gray-400">(default)</span>
                          )}
                        </span>
                      ))}
                    </div>
                  );
                })()}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- runs ---- */}
      <section>
        <h2 className="mb-3 text-lg font-medium">Runs</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-gray-500">No runs yet.</p>
        ) : (
          <ul className="space-y-4">
            {runs.map((run) => (
              <li
                key={run.id}
                className="rounded-lg border border-gray-200 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${RUN_BADGE[run.status]}`}
                    >
                      {run.status}
                    </span>
                    <span className="font-medium">{run.pipelineSlug}</span>
                    <span className="text-xs text-gray-500">
                      {run.pipelineId}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500">
                    started {fmt(run.startedAt)}
                    {run.completedAt
                      ? ` · finished ${fmt(run.completedAt)}`
                      : ''}
                    {' · '}
                    {run.trigger.type}
                    {run.trigger.source ? ` (${run.trigger.source})` : ''}
                  </div>
                </div>

                {/* stage timeline from stageState */}
                <div className="mt-3 space-y-1">
                  {Object.entries(run.stageState).map(([stageId, st]) => (
                    <div
                      key={stageId}
                      className="flex flex-wrap items-center gap-2 text-xs"
                    >
                      <span
                        className={`rounded px-2 py-0.5 font-medium ${STAGE_BADGE[st.status]}`}
                      >
                        {st.status}
                      </span>
                      <span className="font-mono">{stageId}</span>
                      {st.healAttempts > 0 && (
                        <span className="text-purple-600">
                          heals: {st.healAttempts}
                        </span>
                      )}
                      {st.lastError && (
                        <span className="text-red-600">{st.lastError}</span>
                      )}
                      {st.taskIds.length > 0 && (
                        <span className="text-gray-500">
                          tasks:{' '}
                          {st.taskIds.map((id, idx) => (
                            <span key={id}>
                              {idx > 0 && ', '}
                              <a
                                href="/tasks"
                                className="font-mono text-blue-600 hover:underline"
                                title={id}
                              >
                                {id}
                              </a>
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                  ))}
                  {Object.keys(run.stageState).length === 0 && (
                    <p className="text-xs text-gray-400">No stages yet.</p>
                  )}
                </div>

                {/* event log */}
                {run.events.length > 0 && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs text-gray-500">
                      {run.events.length} event
                      {run.events.length === 1 ? '' : 's'}
                    </summary>
                    <ul className="mt-2 space-y-0.5">
                      {run.events.map((e, i) => (
                        <li key={i} className="text-xs text-gray-600">
                          <span className="text-gray-400">{fmt(e.ts)}</span>{' '}
                          <span className="font-mono">{e.stage}</span>{' '}
                          <span className="font-medium">{e.type}</span>
                          {e.detail ? (
                            <span className="text-gray-500"> — {e.detail}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
