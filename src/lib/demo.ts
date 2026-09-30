import type Database from "better-sqlite3";
import { getDb, nowSeconds, type MonitorRow } from "./db";
import { createMonitor } from "./monitors";
import { handleStartPing, handleFinishPing, runCheckerPass } from "./engine";
import { isDemoMode } from "./config";

const FAKE_OOM_LOG = [
  "Starting invoice render job...",
  "Loading template invoice-2024.html",
  "Connecting to postgres://report:EXAMPLE_fake_pw_123@db.internal:5432/billing",
  "api_key=EXAMPLE_fake_secret_456",
  "stripe key sk_test_FAKEDEMO1234567890",
  "aws key AKIAFAKEDEMOEXAMPLE1",
  "Bearer EXAMPLEFAKEDEMOtoken12345",
  "FATAL: JavaScript heap out of memory",
  "Killed (exit 137)",
].join("\n");

const FAKE_LEAK_LOG = [
  "Backup completed successfully",
  "password=EXAMPLE_hunter2_fake",
  "github_pat_FAKEDEMO_1234567890abcdef",
  "postgres://admin:EXAMPLE_db_pass_999@db.internal/main",
  "All 42 tables dumped, checksum ok",
].join("\n");

function seededHistory(
  dd: Database.Database,
  monitorId: number,
  now: number,
  count: number,
  periodSec: number,
  baseDurSec: number
): void {
  // Historical SUCCESS runs with slightly varied durations (chart/average data).
  for (let i = count; i >= 1; i--) {
    const start = now - i * periodSec - (i % 5) * 37;
    const dur = baseDurSec + ((i * 13) % 47) - 23;
    const slot = start - 60;
    dd.prepare(
      `INSERT INTO executions(monitor_id, status, scheduled_for, started_at, finished_at, duration_seconds, exit_code, sanitized_output)
       VALUES(?, 'SUCCESS', ?, ?, ?, ?, 0, ?)`
    ).run(
      monitorId,
      slot,
      start,
      start + dur,
      dur,
      `run #${count - i + 1} ok in ${dur}s`
    );
  }
}

export function ensureDemoSeed(d?: Database.Database): boolean {
  if (!isDemoMode()) return false;
  const dd = d ?? getDb();
  const existing = dd
    .prepare("SELECT COUNT(*) as c FROM monitors")
    .get() as { c: number };
  if (existing.c > 0) return false;
  seedDemo(dd);
  return true;
}

export function seedDemo(dd: Database.Database): void {
  const now = nowSeconds();

  // 1. Nightly Database Backup — HEALTHY, last run ~4h ago, ~3.5 min long.
  const backup = createMonitor(
    {
      name: "Nightly Database Backup",
      slug: "nightly-database-backup",
      cron_expression: "0 2 * * *",
      timezone: "UTC",
      grace_minutes: 15,
      max_runtime_minutes: 60,
      alert_channel_type: "demo",
    },
    dd
  );
  seededHistory(dd, backup.id, now, 20, 86400, 210);
  const fourHoursAgo = now - 4 * 3600;
  handleStartPing(backup.id, fourHoursAgo, dd);
  handleFinishPing(
    backup.id,
    { exitCode: 0, output: "pg_dump done, 1.2GB in 210s", kind: "finish" },
    fourHoursAgo + 210,
    dd
  );

  // 2. Stripe Billing Renewal — MISSED (expected 25 min ago, grace 5).
  const billing = createMonitor(
    {
      name: "Stripe Billing Renewal",
      slug: "stripe-billing-renewal",
      cron_expression: "*/30 * * * *",
      timezone: "UTC",
      grace_minutes: 5,
      max_runtime_minutes: 10,
      alert_channel_type: "demo",
    },
    dd
  );
  seededHistory(dd, billing.id, now, 22, 1800, 45);
  handleStartPing(billing.id, now - 3600, dd);
  handleFinishPing(
    billing.id,
    { exitCode: 0, output: "renewed 128 subscriptions", kind: "finish" },
    now - 3600 + 45,
    dd
  );
  // Move the next-expected timestamp into the past (demo may move timestamps);
  // the real checker pass below flips it to MISSED.
  dd.prepare("UPDATE monitors SET next_expected_at = ? WHERE id = ?").run(
    now - 25 * 60,
    billing.id
  );

  // 3. Invoice PDF Generator — FAILED (exit 137, OOM + fake secrets).
  const invoice = createMonitor(
    {
      name: "Invoice PDF Generator",
      slug: "invoice-pdf-generator",
      cron_expression: "0 8 * * *",
      timezone: "UTC",
      grace_minutes: 10,
      max_runtime_minutes: 30,
      alert_channel_type: "demo",
    },
    dd
  );
  seededHistory(dd, invoice.id, now, 18, 86400, 95);
  handleStartPing(invoice.id, now - 1800, dd);
  handleFinishPing(
    invoice.id,
    { exitCode: 137, output: FAKE_OOM_LOG, kind: "finish" },
    now - 1800 + 60,
    dd
  );

  // 4. Hourly Metric Rollup — RUNAWAY (started ~68 min ago, max runtime 20).
  const rollup = createMonitor(
    {
      name: "Hourly Metric Rollup",
      slug: "hourly-metric-rollup",
      cron_expression: "0 * * * *",
      timezone: "UTC",
      grace_minutes: 5,
      max_runtime_minutes: 20,
      alert_channel_type: "demo",
    },
    dd
  );
  seededHistory(dd, rollup.id, now, 24, 3600, 120);
  const startedAgo = now - 68 * 60;
  handleStartPing(rollup.id, startedAgo, dd);

  // Real checker pass produces MISSED + RUNAWAY + alerts (demo sink = delivered).
  runCheckerPass(now, dd);
}

export type SimulateKind = "crash" | "missed" | "hang" | "leak";

export function simulateDemo(
  monitorId: number,
  kind: SimulateKind,
  d?: Database.Database
): { status: string } {
  const dd = d ?? getDb();
  const now = nowSeconds();
  const m = dd
    .prepare("SELECT * FROM monitors WHERE id = ?")
    .get(monitorId) as MonitorRow | undefined;
  if (!m) throw new Error("Monitor not found");

  if (kind === "crash") {
    handleStartPing(monitorId, now, dd);
    return handleFinishPing(
      monitorId,
      { exitCode: 137, output: FAKE_OOM_LOG, kind: "finish" },
      now,
      dd
    );
  }
  if (kind === "missed") {
    // Move next-expected into the past; the real checker flips the state.
    dd.prepare(
      "UPDATE monitors SET next_expected_at = ?, status = 'HEALTHY', open_incident = NULL WHERE id = ?"
    ).run(now - (m.grace_minutes * 60 + 60), monitorId);
    runCheckerPass(now, dd);
    const after = dd
      .prepare("SELECT status FROM monitors WHERE id = ?")
      .get(monitorId) as { status: string };
    return { status: after.status };
  }
  if (kind === "hang") {
    handleStartPing(monitorId, now, dd);
    const pastStart = now - (m.max_runtime_minutes * 60 + 120);
    dd.prepare(
      "UPDATE monitors SET last_start_at = ? WHERE id = ?"
    ).run(pastStart, monitorId);
    dd.prepare(
      "UPDATE executions SET started_at = ? WHERE monitor_id = ? AND status = 'RUNNING'"
    ).run(pastStart, monitorId);
    runCheckerPass(now, dd);
    const after = dd
      .prepare("SELECT status FROM monitors WHERE id = ?")
      .get(monitorId) as { status: string };
    return { status: after.status };
  }
  // leak: successful run with fake secrets; status must not change.
  handleStartPing(monitorId, now, dd);
  return handleFinishPing(
    monitorId,
    { exitCode: 0, output: FAKE_LEAK_LOG, kind: "finish" },
    now,
    dd
  );
}

export function resetDemo(d?: Database.Database): void {
  const dd = d ?? getDb();
  dd.prepare("DELETE FROM monitors").run();
  dd.prepare("DELETE FROM alerts").run();
  dd.prepare("DELETE FROM executions").run();
  seedDemo(dd);
}
