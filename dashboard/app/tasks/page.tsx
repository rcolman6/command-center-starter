'use client';
import { useEffect, useState } from 'react';
import { Task, TaskStatus } from '@/lib/types';
import TaskForm from '@/components/TaskForm';
import TaskCard from '@/components/TaskCard';

const TABS: { label: string; value: TaskStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Pending', value: 'pending' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Needs Review', value: 'needs_review' },
  { label: 'Completed', value: 'completed' },
];

// cron-config.json carries the worker's cooldown state when a rate limit fires.
type CronConfig = {
  cooldownUntil?: string | null;
  cooldownReason?: string | null;
};

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tab, setTab] = useState<TaskStatus | 'all'>('all');
  const [showForm, setShowForm] = useState(false);
  const [cron, setCron] = useState<CronConfig | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    const [t, c] = await Promise.all([
      fetch('/api/tasks').then((r) => r.json()),
      fetch('/api/cron-config').then((r) => r.json()).catch(() => null),
    ]);
    setTasks(t);
    setCron(c);
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000); // poll for worker-driven status changes
    return () => clearInterval(id);
  }, []);

  const count = (s: TaskStatus | 'all') =>
    s === 'all' ? tasks.length : tasks.filter((t) => t.status === s).length;
  const visible = tab === 'all' ? tasks : tasks.filter((t) => t.status === tab);

  // Active only while the stamp is still in the future — an expired cooldown
  // (which the worker clears on its next tick) never shows.
  const cooldownActive =
    !!cron?.cooldownUntil && new Date(cron.cooldownUntil).getTime() > Date.now();

  const copyDebug = () => {
    navigator.clipboard.writeText(cron?.cooldownReason ?? '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <main className="mx-auto max-w-4xl p-6">
      {cooldownActive && (
        <div className="mb-4 rounded border border-amber-400 bg-amber-50 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold text-amber-900">
                ⚠️ Worker paused — rate-limit cooldown
              </div>
              <div className="text-sm text-amber-800">
                The worker hit a provider usage limit and stood down until{' '}
                <span className="font-medium">
                  {new Date(cron!.cooldownUntil!).toLocaleString()}
                </span>
                . It resumes automatically after that — no action needed.
              </div>
            </div>
            <button
              onClick={copyDebug}
              className="shrink-0 rounded bg-amber-600 px-3 py-1 text-sm text-white"
            >
              {copied ? 'Copied' : 'Copy debug info'}
            </button>
          </div>
          {cron?.cooldownReason && (
            <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-white p-3 text-xs text-gray-800">
              {cron.cooldownReason}
            </pre>
          )}
        </div>
      )}

      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Tasks</h1>
        <button onClick={() => setShowForm((v) => !v)} className="rounded bg-black px-3 py-1.5 text-white">
          + New Task
        </button>
      </div>

      {showForm && <TaskForm onCreated={() => { setShowForm(false); load(); }} />}

      <nav className="my-4 flex gap-2">
        {TABS.map((t) => (
          <button key={t.value} onClick={() => setTab(t.value)}
            className={`rounded px-3 py-1 text-sm ${tab === t.value ? 'bg-black text-white' : 'bg-gray-100'}`}>
            {t.label} <span className="opacity-60">{count(t.value)}</span>
          </button>
        ))}
      </nav>

      <div className="space-y-2">
        {visible.map((task) => (
          <TaskCard key={task.id} task={task} onChanged={load} />
        ))}
      </div>
    </main>
  );
}
