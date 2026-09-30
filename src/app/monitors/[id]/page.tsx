"use client";

import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Copy } from "lucide-react";
import StatusBadge from "@/components/StatusBadge";

type Execution = {
  id: number;
  status: string;
  started_at: number | null;
  duration_seconds: number | null;
  exit_code: number | null;
  scheduled_for: number | null;
};

type Detail = {
  monitor: {
    id: number;
    name: string;
    slug: string;
    ping_token: string;
    cron_expression: string;
    timezone: string;
    status: string;
    alert_channel_type: string | null;
  };
  executions: Execution[];
  latest_log: string | null;
};

function LogText({ log }: { log: string }) {
  const nodes = useMemo(() => {
    const parts = log.split(/(\[REDACTED_[A-Z_]+\])/g);
    return parts.map((p, i) =>
      /^\[REDACTED_[A-Z_]+\]$/.test(p) ? (
        <span
          key={i}
          className="mx-0.5 inline-block rounded bg-violet-500/20 px-1 text-violet-300"
        >
          {p}
        </span>
      ) : (
        <span key={i}>{p}</span>
      )
    );
  }, [log]);
  return <>{nodes}</>;
}

const Chart = memo(function Chart({ runs }: { runs: Execution[] }) {
  const bars = useMemo(() => {
    const ordered = runs.slice().reverse();
    const max = Math.max(1, ...ordered.map((e) => e.duration_seconds ?? 0));
    return ordered.map((e) => ({
      id: e.id,
      h: Math.max(2, ((e.duration_seconds ?? 0) / max) * 76),
      ok: e.status === "SUCCESS",
    }));
  }, [runs]);
  if (bars.length === 0)
    return <p className="text-sm text-[#6b7280]">No runs yet.</p>;
  const w = 300 / bars.length;
  return (
    <svg viewBox="0 0 300 80" role="img" aria-label="Run durations" className="h-20 w-full">
      {bars.map((b, i) => (
        <rect
          key={b.id}
          x={i * w}
          y={80 - b.h}
          width={Math.max(1, w - 1)}
          height={b.h}
          fill={b.ok ? "#10b981" : "#f43f5e"}
        />
      ))}
    </svg>
  );
});

function ChannelEditor({
  monitorId,
  current,
  onSaved,
}: {
  monitorId: number;
  current: string | null;
  onSaved: () => void;
}) {
  const [chType, setChType] = useState(current ?? "none");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    setChType(current ?? "none");
    setUrl("");
    setError(null);
  }, [monitorId, current]);

  const needsUrl = chType === "slack" || chType === "discord" || chType === "webhook";

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch(`/api/monitors/${monitorId}/test-alert`, {
        method: "POST",
      });
      const j = await r.json();
      setTestResult(
        r.ok
          ? "Test message sent. Check the channel now."
          : (j.error ?? "Test failed.")
      );
    } catch {
      setTestResult("Test failed.");
    } finally {
      setTesting(false);
    }
  }
  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const r = await fetch(`/api/monitors/${monitorId}/channel`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alert_channel_type: chType, alert_channel_url: url }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(
          j.errors?.alert_channel_url ??
            j.errors?.alert_channel_type ??
            j.error ??
            "Could not save channel"
        );
        return;
      }
      setSaved(true);
      setUrl("");
      onSaved();
    } catch {
      setError("Could not save channel");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-1.5 space-y-2.5">
      <div>
        <label
          htmlFor="ch-type"
          className="mb-1 block text-xs font-medium text-[#9aa1a9]"
        >
          Alert channel
        </label>
        <select
          id="ch-type"
          value={chType}
          onChange={(e) => setChType(e.target.value)}
          className="w-full rounded-md border border-[#262b31] bg-[#0b0c0e] px-2.5 py-1.5 text-sm"
        >
          <option value="none">None (dashboard only)</option>
          <option value="slack">Slack</option>
          <option value="discord">Discord</option>
          <option value="webhook">Generic webhook</option>
        </select>
      </div>
      {needsUrl && (
        <div>
          <label
            htmlFor="ch-url"
            className="mb-1 block text-xs font-medium text-[#9aa1a9]"
          >
            Webhook URL (stored securely, never displayed again)
          </label>
          <input
            id="ch-url"
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-md border border-[#262b31] bg-[#0b0c0e] px-2.5 py-1.5 text-sm placeholder:text-[#6b7280]"
          />
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-rose-300">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="text-xs text-emerald-300">
          Channel saved.
        </p>
      )}
      {testResult && (
        <p role="status" className="text-xs text-[#9aa1a9]">
          {testResult}
        </p>
      )}
      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-emerald-950 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save channel"}
        </button>
        <button
          onClick={sendTest}
          disabled={testing}
          className="rounded-md border border-[#262b31] px-3 py-1.5 text-sm text-[#9aa1a9] hover:text-white disabled:opacity-60"
        >
          {testing ? "Sending…" : "Send test alert"}
        </button>
      </div>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      aria-label={`Copy ${label}`}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[#262b31] px-2 py-1 text-xs text-[#9aa1a9] hover:text-white"
    >
      {done ? (
        <Check size={12} aria-hidden="true" />
      ) : (
        <Copy size={12} aria-hidden="true" />
      )}
      {done ? "Copied!" : "Copy"}
    </button>
  );
}

const PS_SNIPPET = (ping: string) =>
  `curl.exe -X POST ${ping}/start\n# ... run the job ...\ncurl.exe -X POST ${ping}/finish\n# on failure: curl.exe -X POST "${ping}/finish?exit_code=3"`;

const PYTHON_SNIPPET = (ping: string) =>
  `import urllib.request\nT = "${ping}"\ndef ping(path, body=b""):\n    try:\n        urllib.request.urlopen(T + path, data=body, timeout=5).read()\n    except Exception:\n        pass\nping("/start")\ntry:\n    main()\n    ping("/finish")\nexcept Exception as exc:\n    ping("/fail", str(exc).encode())\n    raise`;

const NODE_SNIPPET = (ping: string) =>
  `const T = "${ping}";\nconst ping = (path, body) =>\n  fetch(T + path, { method: "POST", body, signal: AbortSignal.timeout(5000) }).catch(() => {});\nawait ping("/start");\ntry {\n  await main();\n  await ping("/finish");\n} catch (err) {\n  await ping("/fail", String(err));\n  throw err;\n}`;

export default function MonitorDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [id, setId] = useState<string | null>(null);
  const [data, setData] = useState<Detail | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<"powershell" | "bash" | "python" | "node">(
    "powershell"
  );

  useEffect(() => {
    params.then((p) => setId(p.id));
  }, [params]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await fetch(`/api/monitors/${id}`, { cache: "no-store" });
      if (!r.ok) throw new Error();
      setData(await r.json());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const stats = useMemo(() => {
    const durs = (data?.executions ?? [])
      .filter((e) => e.status === "SUCCESS")
      .map((e) => e.duration_seconds ?? 0)
      .sort((a, b) => a - b);
    if (durs.length === 0) return { avg: "n/a", p50: "n/a", p95: "n/a" };
    const avg = durs.reduce((a, b) => a + b, 0) / durs.length;
    return {
      avg: `${avg.toFixed(1)}s`,
      p50: `${durs[Math.floor(durs.length * 0.5)]}s`,
      p95:
        durs.length >= 20
          ? `${durs[Math.floor(durs.length * 0.95)]}s`
          : "n/a",
    };
  }, [data]);

  if (failed) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <p role="alert" className="text-sm text-rose-300">
          Monitor not found.{" "}
          <Link href="/" className="underline">
            Back to dashboard
          </Link>
        </p>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6" aria-busy="true" aria-label="Loading monitor">
        <div className="skeleton mb-3 h-7 w-56" />
        <div className="skeleton mb-3 h-24" />
        <div className="skeleton h-64" />
      </main>
    );
  }

  const m = data.monitor;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const pingUrl = `${origin}/api/ping/${m.ping_token}`;
  const snippets: Record<typeof tab, string> = {
    powershell: PS_SNIPPET(pingUrl),
    bash: `curl -s ${origin}/skansentinel-exec -o skansentinel-exec && chmod +x skansentinel-exec\n./skansentinel-exec ${origin} ${m.ping_token} -- ./your-job.sh`,
    python: PYTHON_SNIPPET(pingUrl),
    node: NODE_SNIPPET(pingUrl),
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-emerald-400 hover:text-emerald-300"
      >
        <ArrowLeft size={14} aria-hidden="true" /> Dashboard
      </Link>

      <div className="mt-2 flex flex-wrap items-center gap-2.5">
        <h1 className="text-2xl font-semibold tracking-tight">{m.name}</h1>
        <StatusBadge status={m.status} />
      </div>
      <p className="mt-0.5 text-sm text-[#9aa1a9]">
        {m.cron_expression} ({m.timezone})
      </p>

      <section aria-label="Statistics" className="mt-4 grid grid-cols-3 gap-2">
        {(
          [
            ["Average duration", stats.avg],
            ["Median (P50)", stats.p50],
            ["P95", stats.p95],
          ] as [string, string][]
        ).map(([k, v]) => (
          <div
            key={k}
            className="rounded-lg border border-[#262b31] bg-[#141619] px-3.5 py-3"
          >
            <div className="text-xs text-[#9aa1a9]">{k}</div>
            <div className="text-xl font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </section>

      <section
        aria-label="Connect your job"
        className="mt-3 rounded-lg border border-[#262b31] bg-[#141619] px-3.5 py-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Ping URL</h2>
          <CopyButton text={pingUrl} label="ping URL" />
        </div>
        <code className="mt-1.5 block overflow-x-auto rounded-md bg-[#0b0c0e] p-2 text-xs tabular-nums">
          {pingUrl}
        </code>

        <div role="tablist" aria-label="Integration examples" className="mt-3 flex gap-1">
          {(["powershell", "bash", "python", "node"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                tab === t
                  ? "bg-[#1b1e22] text-white"
                  : "text-[#9aa1a9] hover:text-white"
              }`}
            >
              {t === "bash"
                ? "Bash wrapper"
                : t === "powershell"
                  ? "PowerShell"
                  : t === "python"
                    ? "Python"
                    : "Node.js"}
            </button>
          ))}
        </div>
        <div className="mt-1.5 flex items-start gap-2">
          <pre className="flex-1 overflow-x-auto rounded-md bg-[#0b0c0e] p-2.5 font-mono text-xs leading-relaxed">
            {snippets[tab]}
          </pre>
          <CopyButton text={snippets[tab]} label={`${tab} snippet`} />
        </div>
        <p className="mt-1.5 text-xs text-[#6b7280]">
          Pinging never breaks your job. Each example uses a short timeout and ignores network errors.
        </p>
      </section>

      <section
        aria-label="Alert channel"
        className="mt-3 rounded-lg border border-[#262b31] bg-[#141619] px-3.5 py-3"
      >
        <h2 className="text-sm font-medium">Alert channel</h2>
        <p className="mt-0.5 text-xs text-[#9aa1a9]">
          Current: {m.alert_channel_type ?? "none"}. Slack and Discord post a
          short message; generic webhook posts structured JSON. Alerts without
          a channel are kept on the dashboard only.
        </p>
        <ChannelEditor
          monitorId={m.id}
          current={m.alert_channel_type}
          onSaved={load}
        />
      </section>

      <section
        aria-label="Duration chart"
        className="mt-3 rounded-lg border border-[#262b31] bg-[#141619] px-3.5 py-3"
      >
        <h2 className="mb-2 text-sm font-medium">Duration, last 30 runs</h2>
        <Chart runs={data.executions} />
        <p className="mt-1 text-xs text-[#6b7280]">
          Green bars succeeded, red bars failed.
        </p>
      </section>

      <section
        aria-label="Execution history"
        className="mt-3 overflow-x-auto rounded-lg border border-[#262b31] bg-[#141619]"
      >
        <table className="w-full min-w-[620px] text-left text-sm">
          <thead>
            <tr className="border-b border-[#262b31] text-xs uppercase tracking-wide text-[#6b7280]">
              <th scope="col" className="px-3 py-2.5 font-medium">Start</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Duration</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Exit</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Drift</th>
            </tr>
          </thead>
          <tbody>
            {data.executions.map((e) => (
              <tr key={e.id} className="border-b border-[#262b31]/60 last:border-0">
                <td className="px-3 py-2 tabular-nums text-[#9aa1a9]">
                  {e.started_at
                    ? new Date(e.started_at * 1000).toLocaleString()
                    : "n/a"}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {e.duration_seconds === null ? "n/a" : `${e.duration_seconds}s`}
                </td>
                <td className="px-3 py-2 tabular-nums">{e.exit_code ?? "n/a"}</td>
                <td className="px-3 py-2">{e.status}</td>
                <td className="px-3 py-2 tabular-nums text-[#9aa1a9]">
                  {e.started_at !== null && e.scheduled_for !== null
                    ? `${e.started_at - e.scheduled_for}s`
                    : "n/a"}
                </td>
              </tr>
            ))}
            {data.executions.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-[#9aa1a9]">
                  No runs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section
        aria-label="Latest log"
        className="mt-3 rounded-lg border border-[#262b31] bg-[#141619] px-3.5 py-3"
      >
        <h2 className="mb-2 text-sm font-medium">Latest log</h2>
        <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-black p-3 font-mono text-xs leading-relaxed">
          {data.latest_log ? (
            <LogText log={data.latest_log} />
          ) : (
            <span className="text-[#6b7280]">No log output yet.</span>
          )}
        </pre>
      </section>
    </main>
  );
}
