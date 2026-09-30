"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pause, Play, Plus, Trash2 } from "lucide-react";
import StatusBadge from "@/components/StatusBadge";

const NewMonitorForm = dynamic(() => import("@/components/NewMonitorForm"), {
  ssr: false,
});

type Monitor = {
  id: number;
  name: string;
  slug: string;
  cron_expression: string;
  timezone: string;
  status: string;
  paused: boolean;
  last_ping_at: number | null;
  next_expected_at: number | null;
};

type Alert = {
  id: number;
  monitor_name: string;
  alert_type: string;
  delivery_status: string;
  created_at: number;
};

type StatusResp = {
  counts: Record<string, number>;
  monitors: Monitor[];
  alerts: Alert[];
  worker_offline: boolean;
  now: number;
};

function ago(ts: number | null, now: number): string {
  if (ts === null || ts === undefined) return "never";
  const d = now - ts;
  if (d < 0) return "in the future";
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

function expected(ts: number | null, now: number): string {
  if (ts === null || ts === undefined) return "n/a";
  const d = ts - now;
  if (d < 0) {
    const a = -d;
    if (a < 60) return `${a}s overdue`;
    if (a < 3600) return `${Math.floor(a / 60)}m overdue`;
    return `${Math.floor(a / 3600)}h overdue`;
  }
  if (d < 60) return `in ${d}s`;
  if (d < 3600) return `in ${Math.floor(d / 60)}m`;
  return `in ${Math.floor(d / 3600)}h`;
}

const Row = memo(function Row({
  m,
  now,
  onPause,
  onResume,
  onDelete,
}: {
  m: Monitor;
  now: number;
  onPause: (id: number) => void;
  onResume: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <tr className="border-b border-[#262b31]/60 last:border-0">
      <td className="px-3 py-2.5 font-medium">{m.name}</td>
      <td className="px-3 py-2.5 text-[#9aa1a9]">
        {m.cron_expression}{" "}
        <span className="text-[#6b7280]">({m.timezone})</span>
      </td>
      <td className="px-3 py-2.5">
        <StatusBadge status={m.status} />
      </td>
      <td className="px-3 py-2.5 text-[#9aa1a9]">{ago(m.last_ping_at, now)}</td>
      <td className="px-3 py-2.5 text-[#9aa1a9]">
        {expected(m.next_expected_at, now)}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-3">
          <Link
            href={`/monitors/${m.id}`}
            className="text-emerald-400 hover:text-emerald-300"
          >
            Details
          </Link>
          {m.paused ? (
            <button
              onClick={() => onResume(m.id)}
              aria-label={`Resume ${m.name}`}
              className="inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200"
            >
              <Play size={13} aria-hidden="true" /> Resume
            </button>
          ) : (
            <button
              onClick={() => onPause(m.id)}
              aria-label={`Pause ${m.name}`}
              className="inline-flex items-center gap-1 text-amber-300 hover:text-amber-200"
            >
              <Pause size={13} aria-hidden="true" /> Pause
            </button>
          )}
          {confirming ? (
            <span className="inline-flex items-center gap-2 text-xs">
              <span className="text-[#9aa1a9]">Delete?</span>
              <button
                onClick={() => onDelete(m.id)}
                className="font-semibold text-rose-300 hover:text-rose-200"
              >
                Yes
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="text-[#9aa1a9] hover:text-white"
              >
                No
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              aria-label={`Delete ${m.name}`}
              className="inline-flex items-center gap-1 text-[#9aa1a9] hover:text-rose-300"
            >
              <Trash2 size={13} aria-hidden="true" /> Delete
            </button>
          )}
        </div>
      </td>
    </tr>
  );
});

function Skeleton() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6" aria-busy="true" aria-label="Loading dashboard">
      <div className="skeleton mb-4 h-8 w-48" />
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton h-[68px]" />
        ))}
      </div>
      <div className="skeleton h-64" />
    </main>
  );
}

export default function Dashboard() {
  const [data, setData] = useState<StatusResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  // Stable callbacks: the dashboard re-renders every 3s on poll, and an
  // inline onClose would re-fire the form's effects (including its
  // mount-focus) and steal typing focus. These keep their identity.
  const closeNew = useCallback(() => setShowNew(false), []);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/status", { cache: "no-store" });
      if (!r.ok) throw new Error(`Server returned ${r.status}`);
      setData(await r.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load dashboard");
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  const post = useCallback(
    async (url: string, body?: unknown) => {
      await fetch(url, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }).catch(() => {});
      load();
    },
    [load]
  );

  const remove = useCallback(
    async (id: number) => {
      await fetch(`/api/monitors/${id}`, { method: "DELETE" }).catch(() => {});
      load();
    },
    [load]
  );

  const pause = useCallback((id: number) => post(`/api/monitors/${id}/pause`), [post]);
  const resume = useCallback((id: number) => post(`/api/monitors/${id}/resume`), [post]);

  const counts = useMemo(
    () =>
      data?.counts ?? {
        total: 0,
        healthy: 0,
        running: 0,
        missed: 0,
        failed: 0,
        runaway: 0,
      },
    [data]
  );

  if (!data && !error) return <Skeleton />;

  const cards: Array<[string, number]> = [
    ["Total", counts.total ?? 0],
    ["Healthy", counts.healthy ?? 0],
    ["Running", counts.running ?? 0],
    ["Missed", counts.missed ?? 0],
    ["Failed", counts.failed ?? 0],
    ["Runaway", counts.runaway ?? 0],
  ];

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">SkanSentinel</h1>
          <p className="mt-0.5 text-sm text-[#9aa1a9]">
            Silence is the alarm. If a job stops pinging, you hear about it here.
          </p>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3.5 py-2 text-sm font-semibold text-emerald-950"
        >
          <Plus size={15} aria-hidden="true" /> New monitor
        </button>
      </header>

      {data?.worker_offline && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-200"
        >
          Worker offline. The background detection loop has not reported for over
          30 seconds, so statuses may be stale.
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-200"
        >
          <span>Could not load dashboard ({error}).</span>
          <button onClick={load} className="font-semibold underline">
            Retry
          </button>
        </div>
      )}

      <section aria-label="Summary" className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-6">
        {cards.map(([k, v]) => (
          <div
            key={k}
            className="rounded-lg border border-[#262b31] bg-[#141619] px-3.5 py-3"
          >
            <div className="text-xs text-[#9aa1a9]">{k}</div>
            <div className="text-2xl font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </section>

      <section
        aria-label="Monitors"
        className="mb-3 overflow-x-auto rounded-lg border border-[#262b31] bg-[#141619]"
      >
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b border-[#262b31] text-xs uppercase tracking-wide text-[#6b7280]">
              <th scope="col" className="px-3 py-2.5 font-medium">Monitor</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Schedule</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Last seen</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Next expected</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(data?.monitors ?? []).map((m) => (
              <Row
                key={m.id}
                m={m}
                now={data?.now ?? 0}
                onPause={pause}
                onResume={resume}
                onDelete={remove}
              />
            ))}
            {(data?.monitors ?? []).length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-[#9aa1a9]">
                  No monitors yet. Create one to start watching a job.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section
        aria-label="Recent alerts"
        className="rounded-lg border border-[#262b31] bg-[#141619] px-3.5 py-3"
      >
        <h2 className="mb-2 text-sm font-medium">Recent alerts</h2>
        {(data?.alerts ?? []).length === 0 && (
          <p className="text-sm text-[#6b7280]">No alerts yet.</p>
        )}
        <ul className="space-y-1.5 text-sm">
          {(data?.alerts ?? []).map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline gap-x-2.5">
              <span className="tabular-nums text-[#6b7280]">
                {new Date(a.created_at * 1000).toLocaleString()}
              </span>
              <span className="font-medium">{a.monitor_name}</span>
              <span className="text-[#9aa1a9]">{a.alert_type}</span>
              <span className="text-xs text-[#6b7280]">{a.delivery_status}</span>
            </li>
          ))}
        </ul>
      </section>

      {showNew && (
        <NewMonitorForm onClose={closeNew} onDone={load} />
      )}
    </main>
  );
}
