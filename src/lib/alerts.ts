import type Database from "better-sqlite3";
import { getDb, nowSeconds, type MonitorRow } from "./db";
import { sanitizeText } from "./sanitizer";
import { checkWebhookUrlSafe } from "./monitors";

export type AlertType = "FAILED" | "MISSED" | "RUNAWAY" | "RECOVERED";

const LABEL: Record<AlertType, string> = {
  FAILED: "job failed",
  MISSED: "missed scheduled run",
  RUNAWAY: "job is running too long",
  RECOVERED: "job recovered",
};

export function formatAlertMessage(
  monitorName: string,
  type: AlertType,
  exitCode?: number | null
): string {
  const icon = type === "RECOVERED" ? "✅" : "⚠️";
  const safeName = sanitizeText(monitorName).slice(0, 200);
  const ec =
    exitCode !== null && exitCode !== undefined && exitCode !== 0
      ? ` (exit code ${exitCode})`
      : "";
  return `${icon} SkanSentinel: ${safeName} — ${LABEL[type]}${ec}`;
}

export function slackBody(message: string): Record<string, string> {
  return { text: message };
}
export function discordBody(message: string): Record<string, string> {
  return { content: message };
}
export function webhookBody(opts: {
  monitorName: string;
  slug: string;
  alertType: AlertType;
  exitCode?: number | null;
  logTail?: string;
  timestamp: number;
}): Record<string, unknown> {
  const lines = (opts.logTail ?? "").split("\n").slice(-20).join("\n");
  return {
    monitor_name: opts.monitorName,
    slug: opts.slug,
    alert_type: opts.alertType,
    exit_code: opts.exitCode ?? null,
    log_tail: lines,
    timestamp: opts.timestamp,
  };
}

function channelOf(m: MonitorRow): string | null {
  return m.alert_channel_type ?? null;
}

/**
 * Queue an alert for an incident, alert-once per incident kind.
 * Writes state change + alert row in the same transaction.
 * Returns the alert id, or null when suppressed (same incident already open).
 */
export function queueIncidentAlert(
  monitorId: number,
  incidentType: "FAILED" | "MISSED" | "RUNAWAY",
  newStatus: "FAILED" | "MISSED" | "RUNAWAY",
  message: string,
  d?: Database.Database
): number | null {
  const dd = d ?? getDb();
  const now = nowSeconds();
  const txn = dd.transaction(() => {
    const m = dd
      .prepare("SELECT * FROM monitors WHERE id = ?")
      .get(monitorId) as MonitorRow | undefined;
    if (!m || m.paused) return null;
    if (m.open_incident === incidentType) return null; // alert once
    const ch = channelOf(m);
    const safeMsg = sanitizeText(message).slice(0, 4000);
    let delivery = "PENDING";
    let sentAt: number | null = null;
    if (!ch) delivery = "SKIPPED";
    dd.prepare(
      "UPDATE monitors SET status = ?, open_incident = ? WHERE id = ?"
    ).run(newStatus, incidentType, monitorId);
    const r = dd
      .prepare(
        `INSERT INTO alerts(monitor_id, alert_type, message, delivery_status, attempts, next_try_at, created_at, sent_at)
         VALUES(?,?,?,?,?,?,?,?)`
      )
      .run(monitorId, incidentType, safeMsg, delivery, 0, now, now, sentAt);
    return Number(r.lastInsertRowid);
  });
  return txn() as number | null;
}

export function queueRecoveryAlert(
  monitorId: number,
  message: string,
  d?: Database.Database
): number | null {
  const dd = d ?? getDb();
  const now = nowSeconds();
  const txn = dd.transaction(() => {
    const m = dd
      .prepare("SELECT * FROM monitors WHERE id = ?")
      .get(monitorId) as MonitorRow | undefined;
    if (!m || m.paused) return null;
    if (!m.open_incident) return null;
    const ch = channelOf(m);
    const safeMsg = sanitizeText(message).slice(0, 4000);
    let delivery = "PENDING";
    let sentAt: number | null = null;
    if (!ch) delivery = "SKIPPED";
    dd.prepare(
      "UPDATE monitors SET status = 'HEALTHY', open_incident = NULL WHERE id = ?"
    ).run(monitorId);
    const r = dd
      .prepare(
        `INSERT INTO alerts(monitor_id, alert_type, message, delivery_status, attempts, next_try_at, created_at, sent_at)
         VALUES(?,?,?,?,?,?,?,?)`
      )
      .run(monitorId, "RECOVERED", safeMsg, delivery, 0, now, now, sentAt);
    return Number(r.lastInsertRowid);
  });
  return txn() as number | null;
}

export interface SendDeps {
  fetchFn?: typeof fetch;
  nowSec?: number;
}

export async function sendPendingAlerts(
  deps?: SendDeps,
  d?: Database.Database
): Promise<number> {
  const dd = d ?? getDb();
  const now = deps?.nowSec ?? nowSeconds();
  const fetchFn = deps?.fetchFn ?? fetch;
  const rows = dd
    .prepare(
      `SELECT a.*, m.name as monitor_name, m.slug as monitor_slug, m.alert_channel_type as ch_type, m.alert_channel_url as ch_url
       FROM alerts a JOIN monitors m ON m.id = a.monitor_id
       WHERE a.delivery_status = 'PENDING' AND (a.next_try_at IS NULL OR a.next_try_at <= ?)
       ORDER BY a.id ASC LIMIT 20`
    )
    .all(now) as Array<{
    id: number;
    monitor_id: number;
    alert_type: string;
    message: string;
    attempts: number;
    ch_type: string | null;
    ch_url: string | null;
    monitor_name: string;
    monitor_slug: string;
  }>;
  let sent = 0;
  for (const a of rows) {
    if (!a.ch_type || !a.ch_url) {
      dd.prepare("UPDATE alerts SET delivery_status='SKIPPED' WHERE id=?").run(a.id);
      continue;
    }
    // Re-check SSRF safety at send time.
    const safe = await checkWebhookUrlSafe(a.ch_url);
    if (!safe.ok) {
      dd.prepare(
        "UPDATE alerts SET delivery_status='FAILED', attempts=attempts+1 WHERE id=?"
      ).run(a.id);
      continue;
    }
    let body: unknown;
    let extraHeaders: Record<string, string> = {};
    if (a.ch_type === "slack") body = slackBody(a.message);
    else if (a.ch_type === "discord") body = discordBody(a.message);
    else {
      const exec = dd
        .prepare(
          "SELECT sanitized_output, exit_code FROM executions WHERE monitor_id=? ORDER BY id DESC LIMIT 1"
        )
        .get(a.monitor_id) as
        | { sanitized_output: string | null; exit_code: number | null }
        | undefined;
      body = webhookBody({
        monitorName: a.monitor_name,
        slug: a.monitor_slug,
        alertType: a.alert_type as AlertType,
        exitCode: exec?.exit_code ?? null,
        logTail: exec?.sanitized_output ?? "",
        timestamp: now,
      });
      extraHeaders = {};
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetchFn(a.ch_url, {
        method: "POST",
        headers: { "content-type": "application/json", ...extraHeaders },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.ok || (res.status >= 200 && res.status < 300)) {
        dd.prepare(
          "UPDATE alerts SET delivery_status='DELIVERED', sent_at=?, attempts=attempts+1 WHERE id=?"
        ).run(now, a.id);
        sent++;
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch {
      const attempts = a.attempts + 1;
      if (attempts >= 3) {
        dd.prepare(
          "UPDATE alerts SET delivery_status='FAILED', attempts=? WHERE id=?"
        ).run(attempts, a.id);
      } else {
        const delay = attempts === 1 ? 30 : attempts === 2 ? 300 : 900;
        dd.prepare(
          "UPDATE alerts SET attempts=?, next_try_at=? WHERE id=?"
        ).run(attempts, now + delay, a.id);
      }
    }
  }
  return sent;
}
