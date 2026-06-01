'use client';
import { useEffect, useState } from 'react';

interface CronConfig {
  enabled: boolean;
  intervalMinutes: number;
  lastRun: string | null;
  lastTaskId: string | null;
}

const INTERVALS = [5, 10, 15, 30, 60];

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export default function SettingsPage() {
  const [cfg, setCfg] = useState<CronConfig | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () =>
    fetch('/api/cron-config')
      .then((r) => r.json())
      .then((c: CronConfig) => setCfg(c))
      .catch(() => setCfg(null));

  useEffect(() => {
    load();
  }, []);

  const save = async (next: { enabled: boolean; intervalMinutes: number }) => {
    setSaving(true);
    try {
      await fetch('/api/cron-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      await load();
    } finally {
      setSaving(false);
    }
  };

  if (!cfg) {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold text-gray-900">Settings</h1>
        <p className="mt-4 text-sm text-gray-500">Loading…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold text-gray-900">Settings</h1>
      <p className="mt-1 text-sm text-gray-500">
        Turn the worker on or off and set how often it fires. Flipping the
        toggle drives the real crontab.
      </p>

      <section className="mt-8 space-y-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        {/* Enabled toggle */}
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium text-gray-900">Worker enabled</div>
            <div className="text-sm text-gray-500">
              Installs or removes the crontab entry.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={cfg.enabled}
            disabled={saving}
            onClick={() =>
              save({ enabled: !cfg.enabled, intervalMinutes: cfg.intervalMinutes })
            }
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
              cfg.enabled ? 'bg-green-600' : 'bg-gray-300'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                cfg.enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {/* Interval dropdown */}
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium text-gray-900">Interval</div>
            <div className="text-sm text-gray-500">How often the worker ticks.</div>
          </div>
          <select
            value={cfg.intervalMinutes}
            disabled={saving}
            onChange={(e) =>
              save({ enabled: cfg.enabled, intervalMinutes: Number(e.target.value) })
            }
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 shadow-sm focus:border-gray-400 focus:outline-none disabled:opacity-50"
          >
            {INTERVALS.map((m) => (
              <option key={m} value={m}>
                Every {m} min
              </option>
            ))}
          </select>
        </div>

        {/* Last run (read-only liveness) */}
        <div className="border-t border-gray-100 pt-4 text-sm text-gray-600">
          Last run: {relativeTime(cfg.lastRun)}
          {cfg.lastTaskId ? (
            <span className="text-gray-400"> · {cfg.lastTaskId}</span>
          ) : null}
        </div>
      </section>
    </main>
  );
}
