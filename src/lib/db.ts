import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { databasePath } from "./config";
import { nowSeconds } from "./time";

export type MonitorStatus =
  | "PENDING"
  | "HEALTHY"
  | "RUNNING"
  | "LATE"
  | "MISSED"
  | "FAILED"
  | "RUNAWAY"
  | "PAUSED";

export type ExecutionStatus = "RUNNING" | "SUCCESS" | "FAILED" | "ABANDONED";
export type AlertType = "FAILED" | "MISSED" | "RUNAWAY" | "RECOVERED";
export type DeliveryStatus = "PENDING" | "DELIVERED" | "FAILED" | "SKIPPED";

export interface MonitorRow {
  id: number;
  name: string;
  slug: string;
  ping_token: string;
  cron_expression: string;
  timezone: string;
  grace_minutes: number;
  max_runtime_minutes: number;
  status: MonitorStatus;
  paused: number;
  alert_channel_type: string | null;
  alert_channel_url: string | null;
  open_incident: string | null;
  last_ping_at: number | null;
  last_start_at: number | null;
  next_expected_at: number | null;
  created_at: number;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const p = databasePath();
  const dir = path.dirname(p);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

/** For tests: open an isolated in-memory or temp db. */
export function openTestDb(): Database.Database {
  const t = new Database(":memory:");
  t.pragma("journal_mode = WAL");
  t.pragma("foreign_keys = ON");
  t.pragma("busy_timeout = 5000");
  migrate(t);
  return t;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      ping_token TEXT NOT NULL UNIQUE,
      cron_expression TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
      grace_minutes INTEGER NOT NULL DEFAULT 5,
      max_runtime_minutes INTEGER NOT NULL DEFAULT 30,
      status TEXT NOT NULL DEFAULT 'PENDING',
      paused INTEGER NOT NULL DEFAULT 0,
      alert_channel_type TEXT,
      alert_channel_url TEXT,
      open_incident TEXT,
      last_ping_at INTEGER,
      last_start_at INTEGER,
      next_expected_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      scheduled_for INTEGER,
      started_at INTEGER,
      finished_at INTEGER,
      duration_seconds INTEGER,
      exit_code INTEGER,
      sanitized_output TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_executions_monitor ON executions(monitor_id, id DESC);
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      alert_type TEXT NOT NULL,
      message TEXT NOT NULL,
      delivery_status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_try_at INTEGER,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_pending ON alerts(delivery_status, next_try_at);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function getWorkerHeartbeat(d?: Database.Database): number | null {
  const dd = d ?? getDb();
  const row = dd
    .prepare("SELECT value FROM meta WHERE key = 'worker_heartbeat'")
    .get() as { value: string } | undefined;
  return row ? Number(row.value) : null;
}

export function setWorkerHeartbeat(
  nowSec: number,
  d?: Database.Database
): void {
  const dd = d ?? getDb();
  dd.prepare(
    "INSERT INTO meta(key, value) VALUES('worker_heartbeat', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(nowSec));
}

export function pruneExecutions(
  monitorId: number,
  d?: Database.Database
): void {
  const dd = d ?? getDb();
  dd.prepare(
    `DELETE FROM executions WHERE id NOT IN (
       SELECT id FROM executions WHERE monitor_id = ? ORDER BY id DESC LIMIT 200
     ) AND monitor_id = ?`
  ).run(monitorId, monitorId);
}

export { nowSeconds };
