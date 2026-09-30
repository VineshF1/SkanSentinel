import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import type Database from "better-sqlite3";
import { getDb, nowSeconds } from "./db";
import { isDemoMode, allowPrivateWebhooks } from "./config";
import { validateCron, validateTimezone, nextSlotAfter } from "./schedule";

export const SLUG_RE = /^[a-z0-9-]+$/;

export interface CreateMonitorInput {
  name: string;
  slug: string;
  cron_expression: string;
  timezone?: string;
  grace_minutes?: number;
  max_runtime_minutes?: number;
  alert_channel_type?: string | null;
  alert_channel_url?: string | null;
}

export function generatePingToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function validateMonitorInput(
  input: CreateMonitorInput
): { ok: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const name = (input.name ?? "").trim();
  if (!name) errors.name = "Name is required";
  else if (name.length > 100) errors.name = "Name must be at most 100 characters";
  const slug = (input.slug ?? "").trim();
  if (!slug) errors.slug = "Slug is required";
  else if (!SLUG_RE.test(slug))
    errors.slug = "Slug may contain only lowercase letters, digits and dashes";
  const cron = (input.cron_expression ?? "").trim();
  if (!cron) errors.cron_expression = "Cron expression is required";
  else {
    const v = validateCron(cron);
    if (!v.ok) errors.cron_expression = v.error ?? "Invalid cron expression";
  }
  const tz = (input.timezone ?? "Asia/Kolkata").trim() || "Asia/Kolkata";
  if (!validateTimezone(tz)) errors.timezone = "Invalid IANA timezone";
  const grace = input.grace_minutes ?? 5;
  if (!Number.isInteger(grace) || grace < 0 || grace > 1440)
    errors.grace_minutes = "Grace must be 0–1440 minutes";
  const maxRt = input.max_runtime_minutes ?? 30;
  if (!Number.isInteger(maxRt) || maxRt < 1 || maxRt > 10080)
    errors.max_runtime_minutes = "Max runtime must be 1–10080 minutes";
  const chType = input.alert_channel_type ?? null;
  const allowed = ["slack", "discord", "webhook", "demo", null, "", "none"];
  if (chType && !allowed.includes(chType))
    errors.alert_channel_type = "Unknown alert channel";
  if (chType === "demo" && !isDemoMode())
    errors.alert_channel_type = "Demo sink is only available in demo mode";
  if ((chType === "slack" || chType === "discord" || chType === "webhook") && !(input.alert_channel_url ?? "").trim()) {
    errors.alert_channel_url = "Webhook URL is required for this channel";
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

export function isPublicIp(ip: string): boolean {
  if (net.isIP(ip) === 0) return false;
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    const [a, b] = p;
    if (a === 10) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 0) return false;
    if (a >= 224) return false; // multicast + reserved
    if (a === 192 && b === 0 && p[2] === 2) return false; // TEST-NET-1
    if (a === 198 && b === 51 && p[2] === 100) return false;
    if (a === 203 && b === 0 && p[2] === 113) return false;
    if (a === 192 && b === 88 && p[2] === 99) return false;
    if (a === 192 && b === 0 && p[2] === 0) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    return true;
  }
  const low = ip.toLowerCase();
  if (low === "::1") return false;
  if (low.startsWith("fe80:") || low.startsWith("fec0:") || low.startsWith("fc") || low.startsWith("fd"))
    return false;
  if (low.startsWith("ff")) return false;
  if (low === "::" || low.startsWith("::ffff:")) {
    // ipv4-mapped: check embedded v4
    const m = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
    if (m) return isPublicIp(m[1]);
    return false;
  }
  return true;
}

/** SSRF safety: https-only (unless local-testing flag), public DNS only. */
export async function checkWebhookUrlSafe(
  raw: string
): Promise<{ ok: boolean; error?: string }> {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: "Invalid URL" };
  }
  const relaxed = allowPrivateWebhooks();
  if (!relaxed && u.protocol !== "https:") {
    return { ok: false, error: "Only https URLs are allowed" };
  }
  if (relaxed && u.protocol !== "https:" && u.protocol !== "http:") {
    return { ok: false, error: "Only http(s) URLs are allowed" };
  }
  const host = u.hostname;
  if (!relaxed) {
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    ) {
      return { ok: false, error: "Private hosts are not allowed" };
    }
  }
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.length === 0) return { ok: false, error: "Host does not resolve" };
    if (!relaxed) {
      for (const a of addrs) {
        if (!isPublicIp(a.address)) {
          return { ok: false, error: "Host resolves to a private address" };
        }
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Host does not resolve" };
  }
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "monitor"
  );
}

export function createMonitor(
  input: CreateMonitorInput,
  d?: Database.Database
): { id: number; ping_token: string } {
  const dd = d ?? getDb();
  const now = nowSeconds();
  const tz = (input.timezone ?? "Asia/Kolkata").trim() || "Asia/Kolkata";
  const grace = input.grace_minutes ?? 5;
  const token = generatePingToken();
  const nextExpected = nextSlotAfter(input.cron_expression.trim(), tz, now);
  const chType =
    !input.alert_channel_type || input.alert_channel_type === "none"
      ? null
      : input.alert_channel_type;
  const chUrl = chType ? (input.alert_channel_url ?? "").trim() || null : null;
  const row = dd
    .prepare(
      `INSERT INTO monitors(name, slug, ping_token, cron_expression, timezone, grace_minutes, max_runtime_minutes, status, paused, alert_channel_type, alert_channel_url, open_incident, next_expected_at, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      input.name.trim(),
      input.slug.trim(),
      token,
      input.cron_expression.trim(),
      tz,
      grace,
      input.max_runtime_minutes ?? 30,
      "PENDING",
      0,
      chType,
      chUrl,
      null,
      nextExpected,
      now
    );
  return { id: Number(row.lastInsertRowid), ping_token: token };
}

export function pauseMonitor(id: number, d?: Database.Database): void {
  const dd = d ?? getDb();
  dd.prepare(
    "UPDATE monitors SET paused = 1, status = 'PAUSED' WHERE id = ?"
  ).run(id);
}

export function resumeMonitor(id: number, d?: Database.Database): void {
  const dd = d ?? getDb();
  const m = dd.prepare("SELECT * FROM monitors WHERE id = ?").get(id) as {
    cron_expression: string;
    timezone: string;
  } | undefined;
  if (!m) return;
  const now = nowSeconds();
  const nxt = nextSlotAfter(m.cron_expression, m.timezone || "UTC", now);
  dd.prepare(
    "UPDATE monitors SET paused = 0, status = 'PENDING', open_incident = NULL, next_expected_at = ? WHERE id = ?"
  ).run(nxt, id);
}

export function deleteMonitor(id: number, d?: Database.Database): void {
  const dd = d ?? getDb();
  dd.prepare("DELETE FROM monitors WHERE id = ?").run(id);
}
