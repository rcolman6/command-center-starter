'use client';
import { useEffect, useState } from 'react';
import { Task, ModelId, AgentEngine } from '@/lib/types';

export default function TaskForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<0 | 1 | 2 | 3 | 4 | 5>(3);
  const [engine, setEngine] = useState<AgentEngine>('claude');
  const [model, setModel] = useState<ModelId>('sonnet');
  const [codexModel, setCodexModel] = useState('');
  const [slashCommand, setSlashCommand] = useState('');
  const [commands, setCommands] = useState<string[]>([]);
  const [criteria, setCriteria] = useState<string[]>(['']);

  useEffect(() => {
    fetch('/api/slash-commands')
      .then((r) => r.json())
      .then((list: string[]) => setCommands(Array.isArray(list) ? list : []))
      .catch(() => setCommands([]));
  }, []);

  const setCriterion = (i: number, v: string) =>
    setCriteria((c) => c.map((x, j) => (j === i ? v : x)));
  const addCriterion = () => setCriteria((c) => [...c, '']);
  const removeCriterion = (i: number) =>
    setCriteria((c) => c.filter((_, j) => j !== i));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body: Partial<Task> = {
      title,
      description,
      priority,                       // 0..5
      engine,                         // 'claude' | 'codex'
      model,                          // 'sonnet' | 'opus' | 'haiku' (claude only)
      slashCommand: slashCommand || null,
      acceptanceCriteria: criteria.filter(Boolean),
    };
    // Codex model is an optional override; unset → the worker uses codex's config default.
    if (engine === 'codex' && codexModel.trim()) {
      body.metadata = { codexModel: codexModel.trim() };
    }
    await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),     // server stamps id/createdAt/status='pending' + the rest
    });
    onCreated();
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded border p-4">
      <div>
        <label className="block text-sm font-medium">Title</label>
        <input
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded border px-2 py-1 text-sm"
        />
      </div>

      <div>
        <label className="block text-sm font-medium">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="w-full rounded border px-2 py-1 text-sm"
        />
      </div>

      <div className="flex gap-3">
        <div>
          <label className="block text-sm font-medium">Priority</label>
          <select
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value) as 0 | 1 | 2 | 3 | 4 | 5)}
            className="rounded border px-2 py-1 text-sm"
          >
            {[0, 1, 2, 3, 4, 5].map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium">Engine</label>
          <select
            value={engine}
            onChange={(e) => setEngine(e.target.value as AgentEngine)}
            className="rounded border px-2 py-1 text-sm"
          >
            <option value="claude">claude</option>
            <option value="codex">codex</option>
          </select>
        </div>

        {engine === 'claude' ? (
          <div>
            <label className="block text-sm font-medium">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as ModelId)}
              className="rounded border px-2 py-1 text-sm"
            >
              <option value="sonnet">sonnet</option>
              <option value="opus">opus</option>
              <option value="haiku">haiku</option>
            </select>
          </div>
        ) : (
          <div>
            <label className="block text-sm font-medium">Codex model</label>
            <input
              value={codexModel}
              onChange={(e) => setCodexModel(e.target.value)}
              placeholder="(config default)"
              className="rounded border px-2 py-1 text-sm"
            />
          </div>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium">Slash Command</label>
        <select
          value={slashCommand}
          onChange={(e) => setSlashCommand(e.target.value)}
          className="w-full rounded border px-2 py-1 text-sm"
        >
          <option value="">(none)</option>
          {commands.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium">Acceptance Criteria</label>
        {criteria.map((c, i) => (
          <div key={i} className="mt-1 flex gap-2">
            <input
              value={c}
              onChange={(e) => setCriterion(i, e.target.value)}
              className="flex-1 rounded border px-2 py-1 text-sm"
            />
            <button
              type="button"
              onClick={() => removeCriterion(i)}
              className="rounded bg-gray-100 px-2 text-sm"
            >
              −
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addCriterion}
          className="mt-1 text-sm underline"
        >
          + Add criterion
        </button>
      </div>

      <button type="submit" className="rounded bg-black px-3 py-1.5 text-white">
        Create Task
      </button>
    </form>
  );
}
