'use client';
import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import { Task } from '@/lib/types';

type ExtraOutput = { label: string; path: string };

const STATUS_BADGE: Record<Task['status'], string> = {
  pending: 'bg-gray-200 text-gray-700',
  in_progress: 'bg-blue-200 text-blue-800',
  needs_review: 'bg-amber-200 text-amber-900',
  completed: 'bg-green-200 text-green-800',
};

export default function TaskCard({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [body, setBody] = useState('');
  const [showApprove, setShowApprove] = useState(false);
  const [showRevise, setShowRevise] = useState(false);
  const [captainNotes, setCaptainNotes] = useState('');
  const [reviseNotes, setReviseNotes] = useState('');
  const [agentTab, setAgentTab] = useState<'prompt' | 'output'>('prompt');

  const snapshot = task.metadata?.promptSnapshot as string | undefined;
  const extras = (task.metadata?.extraOutputs as ExtraOutput[] | undefined) ?? [];
  const ext = task.completionFile?.split('.').pop();

  useEffect(() => {
    if (!expanded || !task.completionFile) return;
    fetch(`/api/files/${task.completionFile}`)
      .then((r) => r.text())
      .then(setBody)
      .catch(() => setBody(''));
  }, [expanded, task.completionFile]);

  const patch = (b: Partial<Task>) =>
    fetch(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    }).then(onChanged);

  const approve = () => patch({ status: 'completed', captainNotes });
  const revise = () => patch({ status: 'pending', claudeNotes: `[REVISION REQUESTED]\n${reviseNotes}` });
  const reopen = () => patch({ status: 'pending' });
  const deleteTask = () => {
    if (!window.confirm('Delete this task? This cannot be undone.')) return;
    fetch(`/api/tasks/${task.id}`, { method: 'DELETE' }).then(onChanged);
  };

  return (
    <div className="rounded border">
      {/* Collapsed row */}
      <div
        className="flex cursor-pointer items-center gap-3 p-3"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-xs font-mono text-gray-500">P{task.priority}</span>
        <span className="flex-1 font-medium">{task.title}</span>
        <span className={`rounded px-2 py-0.5 text-xs ${STATUS_BADGE[task.status]}`}>
          {task.status}
        </span>
        {(task.status === 'needs_review' || task.status === 'completed') && task.completionFile && (
          <a
            href={`/api/files/${task.completionFile}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-sm underline"
          >
            Output
          </a>
        )}
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div className="space-y-4 border-t p-3">
          {task.description && (
            <p className="whitespace-pre-wrap text-sm text-gray-700">{task.description}</p>
          )}

          {task.acceptanceCriteria.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase text-gray-500">Acceptance Criteria</div>
              {task.acceptanceCriteria.map((c, i) => (
                <label key={i} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" readOnly />
                  {c}
                </label>
              ))}
            </div>
          )}

          {task.claudeNotes && (
            <div>
              <div className="text-xs font-semibold uppercase text-gray-500">Claude Notes</div>
              <pre className="whitespace-pre-wrap text-sm text-gray-700">{task.claudeNotes}</pre>
            </div>
          )}

          {/* extraOutputs (§5.3a) */}
          {extras.map((o) => (
            <a
              key={o.path}
              href={`/api/files/${o.path}`}
              target="_blank"
              rel="noreferrer"
              className="block text-sm underline"
            >
              {o.label}
            </a>
          ))}

          {/* draft copy-to-clipboard branch (§5.3c) */}
          {task.metadata?.kind === 'draft' && (
            <div className="rounded border p-3">
              <button
                onClick={() => navigator.clipboard.writeText(body)}
                className="mb-2 text-xs underline"
              >
                Copy to clipboard
              </button>
              <pre className="whitespace-pre-wrap text-sm">{body}</pre>
            </div>
          )}

          {/* Inline file render (§5.3b) */}
          {task.completionFile && (
            <div className="rounded border p-3">
              {ext === 'md' ? (
                <Markdown>{body}</Markdown>
              ) : ext === 'diff' || ext === 'patch' ? (
                <pre className="overflow-auto text-xs">{body}</pre>
              ) : ext === 'png' || ext === 'jpg' ? (
                <img src={`/api/files/${task.completionFile}`} alt={task.title} />
              ) : (
                <pre className="whitespace-pre-wrap text-sm">{body}</pre>
              )}
            </div>
          )}

          {/* Review controls */}
          {task.status === 'needs_review' && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <button
                  onClick={() => { setShowApprove((v) => !v); setShowRevise(false); }}
                  className="rounded bg-green-600 px-3 py-1 text-sm text-white"
                >
                  Approve
                </button>
                <button
                  onClick={() => { setShowRevise((v) => !v); setShowApprove(false); }}
                  className="rounded bg-amber-600 px-3 py-1 text-sm text-white"
                >
                  Revise
                </button>
                <button
                  onClick={deleteTask}
                  className="rounded bg-red-600 px-3 py-1 text-sm text-white"
                >
                  Delete
                </button>
              </div>

              {showApprove && (
                <div className="space-y-2">
                  <textarea
                    value={captainNotes}
                    onChange={(e) => setCaptainNotes(e.target.value)}
                    placeholder="Captain notes (optional)"
                    rows={3}
                    className="w-full rounded border px-2 py-1 text-sm"
                  />
                  <button
                    onClick={approve}
                    className="rounded bg-green-600 px-3 py-1 text-sm text-white"
                  >
                    Confirm Approve
                  </button>
                </div>
              )}

              {showRevise && (
                <div className="space-y-2">
                  <textarea
                    value={reviseNotes}
                    onChange={(e) => setReviseNotes(e.target.value)}
                    placeholder="What needs to change?"
                    rows={3}
                    className="w-full rounded border px-2 py-1 text-sm"
                  />
                  <button
                    onClick={revise}
                    className="rounded bg-amber-600 px-3 py-1 text-sm text-white"
                  >
                    Confirm Revise
                  </button>
                </div>
              )}
            </div>
          )}

          {task.status === 'completed' && (
            <button
              onClick={reopen}
              className="rounded bg-gray-200 px-3 py-1 text-sm"
            >
              Reopen
            </button>
          )}

          {/* Agent view (observability §3) */}
          <div className="rounded border">
            <div className="flex gap-2 border-b p-2">
              <button
                onClick={() => setAgentTab('prompt')}
                className={`rounded px-3 py-1 text-sm ${agentTab === 'prompt' ? 'bg-black text-white' : 'bg-gray-100'}`}
              >
                Prompt
              </button>
              <button
                onClick={() => setAgentTab('output')}
                className={`rounded px-3 py-1 text-sm ${agentTab === 'output' ? 'bg-black text-white' : 'bg-gray-100'}`}
              >
                Output
              </button>
            </div>
            <div className="p-2">
              {agentTab === 'prompt' && (
                <pre className="whitespace-pre-wrap font-mono text-xs">
                  {snapshot ?? 'No prompt snapshot recorded.'}
                </pre>
              )}
              {agentTab === 'output' && (
                <SessionView taskId={task.id} notes={task.claudeNotes} file={task.completionFile} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type StreamEntry = {
  type?: string;
  result?: unknown;
  message?: { content?: Array<Record<string, unknown>> };
  // codex `--json` events carry their payload under `item`.
  item?: {
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
  };
};

function SessionView({
  taskId,
  notes,
  file,
}: {
  taskId: string;
  notes: string;
  file: string | null;
}) {
  const [raw, setRaw] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    fetch(`/api/sessions/${taskId}`)
      .then((r) => {
        if (!r.ok) {
          setMissing(true);
          return '';
        }
        return r.text();
      })
      .then((t) => setRaw(t))
      .catch(() => setMissing(true));
  }, [taskId]);

  const renderEntries = () => {
    if (!raw) return null;
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    const entries: StreamEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        /* ignore malformed line */
      }
    }

    // Fallback: a single JSON object (not NDJSON) — show .result or the raw text.
    if (entries.length <= 1) {
      let single: StreamEntry | null = null;
      try {
        single = JSON.parse(raw);
      } catch {
        single = entries[0] ?? null;
      }
      const result = single && typeof single.result === 'string' ? single.result : null;
      return (
        <pre className="whitespace-pre-wrap text-sm">{result ?? raw}</pre>
      );
    }

    const rows: React.ReactNode[] = [];
    entries.forEach((e, idx) => {
      const content = e.message?.content;
      if (e.type === 'assistant' && Array.isArray(content)) {
        content.forEach((c, j) => {
          if (c.type === 'text' && typeof c.text === 'string') {
            rows.push(
              <pre key={`${idx}-${j}-t`} className="whitespace-pre-wrap text-sm">{c.text}</pre>
            );
          } else if (c.type === 'tool_use') {
            rows.push(
              <div key={`${idx}-${j}-tu`} className="rounded bg-gray-100 p-2 text-xs">
                <div className="font-semibold">tool_use: {String(c.name)}</div>
                <pre className="whitespace-pre-wrap">{JSON.stringify(c.input, null, 2)}</pre>
              </div>
            );
          }
        });
      } else if (e.type === 'user' && Array.isArray(content)) {
        content.forEach((c, j) => {
          if (c.type === 'tool_result') {
            const tr = typeof c.content === 'string' ? c.content : JSON.stringify(c.content, null, 2);
            rows.push(
              <div key={`${idx}-${j}-tr`} className="rounded bg-gray-50 p-2 text-xs">
                <div className="font-semibold">tool_result</div>
                <pre className="whitespace-pre-wrap">{tr}</pre>
              </div>
            );
          }
        });
      } else if (e.type === 'result' && typeof e.result === 'string') {
        rows.push(
          <div key={`${idx}-r`} className="rounded border p-2 text-sm">
            <div className="text-xs font-semibold uppercase text-gray-500">Result</div>
            <pre className="whitespace-pre-wrap">{e.result}</pre>
          </div>
        );
      } else if (e.type === 'item.completed' && e.item) {
        // codex `--json` events: render agent prose and shell commands.
        const it = e.item;
        if (it.type === 'agent_message' && typeof it.text === 'string') {
          rows.push(
            <pre key={`${idx}-am`} className="whitespace-pre-wrap text-sm">{it.text}</pre>
          );
        } else if (it.type === 'reasoning' && typeof it.text === 'string') {
          rows.push(
            <pre key={`${idx}-re`} className="whitespace-pre-wrap text-sm italic text-gray-500">{it.text}</pre>
          );
        } else if (it.type === 'command_execution' && typeof it.command === 'string') {
          rows.push(
            <div key={`${idx}-cmd`} className="rounded bg-gray-100 p-2 text-xs">
              <div className="font-semibold">
                $ {it.command}
                {typeof it.exit_code === 'number' ? ` (exit ${it.exit_code})` : ''}
              </div>
              {it.aggregated_output ? (
                <pre className="whitespace-pre-wrap">{it.aggregated_output}</pre>
              ) : null}
            </div>
          );
        }
      }
    });
    return <div className="space-y-2">{rows}</div>;
  };

  return (
    <div className="space-y-3">
      {missing ? (
        <p className="text-sm text-gray-500">No session yet.</p>
      ) : (
        renderEntries()
      )}

      {notes && (
        <div>
          <div className="text-xs font-semibold uppercase text-gray-500">Notes</div>
          <pre className="whitespace-pre-wrap text-sm text-gray-700">{notes}</pre>
        </div>
      )}

      {file && (
        <a href={`/api/files/${file}`} target="_blank" rel="noreferrer" className="block text-sm underline">
          {file}
        </a>
      )}
    </div>
  );
}
