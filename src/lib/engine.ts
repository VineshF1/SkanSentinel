import type Database from "better-sqlite3";
import {
  getDb,
  nowSeconds,
  pruneExecutions,
  setWorkerHeartbeat,
  type MonitorRow,
} from "./db";
import { sanitizeText } from "./sanitizer";
import { advanceExpected, previousSlot } from "./schedule";
import {
  queueIncidentAlert,
  queueRecoveryAlert,
  formatAlertMessage,
} from "./alerts";

// ---- rate limit (in-memory, per token, 60/min sliding window) ----
const hits = new Map<string, number[]>();

export function checkRateLimit(token: string, nowSec: number): boolean {
  const arr = (hits.get(token) ?? []).filter((t) => t > nowSec - 60);
  if (arr.length >= 60) {
    hits.set(token, arr);
    return false;
  }
  arr.push(nowSec);
  hits.set(token, arr);
  // Opportunistic prune so dead tokens cannot grow the map without bound.
  if (hits.size > 10000) {
    for (const [k, v] of hits) {
      if (v.length === 0 || v[v.length - 1] <= nowSec - 60) hits.delete(k);
      if (hits.size <= 5000) break;
    }
  }
  return true;
}

export function clearRateLimits(): void {
  hits.clear();
}

export function findMonitorByToken(
  token: string,
  d?: Database.Database
): MonitorRow | undefined {
  const dd = d ?? getDb();
  return dd
    .prepare("SELECT * FROM monitors WHERE ping_token = ?")
    .get(token) as MonitorRow | undefined;
}

export interface FinishOpts {
  exitCode: number | null; // null = default per kind
  output?: string;
  kind: "finish" | "fail" | "heartbeat";
  durationSeconds?: number | null;
}

export function resolveExitCode(
  raw: unknown,
  kind: "finish" | "fail" | "heartbeat"
): number {
  if (raw === undefined || raw === null || raw === "") {
    return kind === "fail" ? 1 : 0;
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(Math.trunc(n))) {
    // Non-number counts as 1. Truncate floats.
    if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
    return 1;
  }
  if (kind === "fail" && Math.trunc(n) === 0) return 1;
  return Math.trunc(n);
}

export function handleStartPing(
  monitorId: number,
  nowSec?: number,
  d?: Database.Database
): void {
  const dd = d ?? getDb();
  const now = nowSec ?? nowSeconds();
  const txn = dd.transaction(() => {
    const m = dd
      .prepare("SELECT * FROM monitors WHERE id = ?")
      .get(monitorId) as MonitorRow | undefined;
    if (!m || m.paused) return;
    // Abandon older running execution.
    dd.prepare(
      "UPDATE executions SET status='ABANDONED', finished_at=? WHERE monitor_id=? AND status='RUNNING'"
    ).run(now, monitorId);
    const slot = previousSlot(m.cron_expression, m.timezone || "UTC", now);
    dd.prepare(
      `INSERT INTO executions(monitor_id, status, scheduled_for, started_at, finished_at, duration_seconds, exit_code, sanitized_output)
       VALUES(?, 'RUNNING', ?, ?, NULL, NULL, NULL, NULL)`
    ).run(monitorId, slot, now);
    dd.prepare(
      "UPDATE monitors SET status='RUNNING', last_start_at=?, last_ping_at=? WHERE id=?"
    ).run(now, now, monitorId);
  });
  txn();
  pruneExecutions(monitorId, dd);
}

export function handleFinishPing(
  monitorId: number,
  opts: FinishOpts,
  nowSec?: number,
  d?: Database.Database
): { status: string } {
  const dd = d ?? getDb();
  const now = nowSec ?? nowSeconds();
  const exitCode = resolveExitCode(opts.exitCode, opts.kind);
  const clean = sanitizeText(opts.output ?? "").slice(-65536);

  const m = dd
    .prepare("SELECT * FROM monitors WHERE id = ?")
    .get(monitorId) as MonitorRow | undefined;
  if (!m) return { status: "UNKNOWN" };
  if (m.paused) return { status: "PAUSED" };

  const open = dd
    .prepare(
      "SELECT * FROM executions WHERE monitor_id=? AND status='RUNNING' ORDER BY id DESC LIMIT 1"
    )
    .get(monitorId) as
    | { id: number; started_at: number | null; scheduled_for: number | null }
    | undefined;

  let scheduledFor: number | null = open?.scheduled_for ?? null;
  if (scheduledFor === null || scheduledFor === undefined) {
    scheduledFor = previousSlot(m.cron_expression, m.timezone || "UTC", now);
  }
  const startedAt: number | null = open?.started_at ?? now;
  let duration = Math.max(0, now - (startedAt ?? now));
  if (!open && opts.durationSeconds !== null && opts.durationSeconds !== undefined) {
    const ds = Math.trunc(Number(opts.durationSeconds));
    if (Number.isFinite(ds) && ds >= 0) duration = ds;
  }

  const txn = dd.transaction(() => {
    if (open) {
      dd.prepare(
        "UPDATE executions SET status=?, finished_at=?, duration_seconds=?, exit_code=?, sanitized_output=? WHERE id=?"
      ).run(
        exitCode === 0 ? "SUCCESS" : "FAILED",
        now,
        duration,
        exitCode,
        clean,
        open.id
      );
    } else {
      dd.prepare(
        `INSERT INTO executions(monitor_id, status, scheduled_for, started_at, finished_at, duration_seconds, exit_code, sanitized_output)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        monitorId,
        exitCode === 0 ? "SUCCESS" : "FAILED",
        scheduledFor,
        startedAt,
        now,
        duration,
        exitCode,
        clean
      );
    }
    const nextExpected = advanceExpected(
      m.cron_expression,
      m.timezone || "UTC",
      scheduledFor,
      now,
      m.grace_minutes
    );
    dd.prepare(
      "UPDATE monitors SET last_ping_at=?, next_expected_at=? WHERE id=?"
    ).run(now, nextExpected, monitorId);
  });
  txn();
  pruneExecutions(monitorId, dd);

  if (exitCode === 0) {
    const msg = formatAlertMessage(m.name, "RECOVERED", exitCode);
    // queueRecoveryAlert sets status HEALTHY when an incident was open.
    const rid = queueRecoveryAlert(monitorId, msg, dd);
    if (rid === null) {
      // No open incident: just mark healthy.
      dd.prepare("UPDATE monitors SET status='HEALTHY' WHERE id=?").run(
        monitorId
      );
    }
    return { status: "HEALTHY" };
  }
  const msg = formatAlertMessage(m.name, "FAILED", exitCode);
  queueIncidentAlert(monitorId, "FAILED", "FAILED", msg, dd);
  return { status: "FAILED" };
}

/** Checker pass over all unpaused monitors. Returns counts for observability. */
export function runCheckerPass(
  nowSec?: number,
  d?: Database.Database
): { late: number; missed: number; runaway: number } {
  const dd = d ?? getDb();
  const now = nowSec ?? nowSeconds();
  let late = 0;
  let missed = 0;
  let runaway = 0;
  const monitors = dd
    .prepare("SELECT * FROM monitors WHERE paused = 0")
    .all() as MonitorRow[];
  for (const m of monitors) {
    if (m.status === "RUNNING") {
      const started = m.last_start_at ?? null;
      const maxSec = m.max_runtime_minutes * 60;
      if (started !== null && now - started > maxSec) {
        const msg = formatAlertMessage(m.name, "RUNAWAY", null);
        const id = queueIncidentAlert(m.id, "RUNAWAY", "RUNAWAY", msg, dd);
        if (id !== null) runaway++;
        continue;
      }
      // RUNNING within max runtime: leave alone.
      continue;
    }
    if (m.status === "MISSED" || m.status === "RUNAWAY" || m.status === "PAUSED") {
      continue; // sticky
    }
    const expected = m.next_expected_at;
    if (expected === null || expected === undefined) continue;
    const graceSec = m.grace_minutes * 60;
    if (now > expected + graceSec) {
      // PENDING, HEALTHY, LATE, FAILED → MISSED
      if (
        m.status === "PENDING" ||
        m.status === "HEALTHY" ||
        m.status === "LATE" ||
        m.status === "FAILED"
      ) {
        const msg = formatAlertMessage(m.name, "MISSED", null);
        const id = queueIncidentAlert(m.id, "MISSED", "MISSED", msg, dd);
        if (id !== null) missed++;
      }
    } else if (now > expected) {
      if (m.status !== "LATE") {
        dd.prepare("UPDATE monitors SET status='LATE' WHERE id=?").run(m.id);
      }
      late++;
    }
  }
  setWorkerHeartbeat(now, dd);
  return { late, missed, runaway };
}
