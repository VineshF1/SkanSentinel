import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openTestDb } from "@/lib/db";
import { sanitizeText } from "@/lib/sanitizer";
import {
  validateCron,
  validateTimezone,
  describeCron,
  nextSlotAfter,
  next3Slots,
  advanceExpected,
} from "@/lib/schedule";
import { nowSeconds } from "@/lib/time";
import { createMonitor, isPublicIp, checkWebhookUrlSafe } from "@/lib/monitors";
import {
  handleStartPing,
  handleFinishPing,
  runCheckerPass,
  checkRateLimit,
  clearRateLimits,
  findMonitorByToken,
  resolveExitCode,
} from "@/lib/engine";
import {
  queueIncidentAlert,
  queueRecoveryAlert,
  sendPendingAlerts,
  slackBody,
  discordBody,
  webhookBody,
  formatAlertMessage,
} from "@/lib/alerts";
import { readPingBody } from "@/lib/ping-request";
import { timingSafeCompare, parseBasicAuth } from "@/lib/auth";

let db: Database.Database;

function mkMonitor(over: Record<string, unknown> = {}): number {
  const base = {
    name: "Test Job",
    slug: `test-job-${Math.random().toString(36).slice(2, 8)}`,
    cron_expression: "*/5 * * * *",
    timezone: "UTC",
    grace_minutes: 5,
    max_runtime_minutes: 30,
    alert_channel_type: null,
  };
  const { id } = createMonitor({ ...base, ...over } as never, db);
  return id;
}

beforeEach(() => {
  if (db) db.close();
  db = openTestDb();
  clearRateLimits();
});

// ---------- sanitizer (12) ----------
describe("sanitizer", () => {
  it("redacts private key blocks", () => {
    const s = sanitizeText(
      "k -----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY----- k"
    );
    expect(s).toContain("[REDACTED_PRIVATE_KEY]");
    expect(s).not.toContain("BEGIN RSA");
  });
  it("redacts credentials inside URLs", () => {
    const s = sanitizeText("postgres://user:s3cret@db.internal:5432/main");
    expect(s).toContain("[REDACTED_CREDENTIALS]");
    expect(s).not.toContain("s3cret");
  });
  it("redacts JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(sanitizeText(`tok ${jwt}`)).toContain("[REDACTED_JWT]");
  });
  it("redacts Bearer tokens", () => {
    expect(sanitizeText("Proxy: Bearer abcDEF123")).toContain(
      "Bearer [REDACTED_TOKEN]"
    );
  });
  it("redacts AWS access keys", () => {
    const s = sanitizeText("key AKIAIOSFODNN7EXAMPLE here");
    expect(s).toContain("[REDACTED_AWS_KEY]");
    expect(s).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
  it("redacts known API key prefixes", () => {
    expect(sanitizeText("sk_live_abc123xyz")).toContain("[REDACTED_API_KEY]");
    expect(sanitizeText("ghp_abc123xyzDEF")).toContain("[REDACTED_API_KEY]");
    expect(sanitizeText("AIzaSyD_fake_key_123")).toContain("[REDACTED_API_KEY]");
  });
  it("redacts name=value secrets", () => {
    const s = sanitizeText("db password=hunter2 ok");
    expect(s).toContain("[REDACTED_SECRET]");
    expect(s).not.toContain("hunter2");
  });
  it("redacts name: value secrets case-insensitively", () => {
    expect(sanitizeText("API_SECRET: topsecret")).toContain("[REDACTED_SECRET]");
  });
  it("leaves normal text unchanged", () => {
    const t = "Backup done, 42 tables in 210s, all green.";
    expect(sanitizeText(t)).toBe(t);
  });
  it(
    "keeps only the last 64KB",
    () => {
      const big = "a".repeat(70 * 1024) + "TAIL";
      const s = sanitizeText(big);
      expect(s.length).toBeLessThanOrEqual(64 * 1024);
      expect(s.endsWith("TAIL")).toBe(true);
    },
    30000
  );
  it("never throws on weird input", () => {
    expect(() => sanitizeText(null)).not.toThrow();
    expect(() => sanitizeText(undefined)).not.toThrow();
    expect(() => sanitizeText(12345)).not.toThrow();
    expect(() => sanitizeText({})).not.toThrow();
  });
  it("withholds output instead of throwing", () => {
    const evil = { toString() { throw new Error("boom"); } };
    expect(sanitizeText(evil)).toMatch(/withheld/);
  });
});

// ---------- schedule (8) ----------
describe("schedule", () => {
  it("rejects non-5-field cron", () => {
    expect(validateCron("* * * *").ok).toBe(false);
    expect(validateCron("* * * * * *").ok).toBe(false);
  });
  it("rejects invalid cron", () => {
    expect(validateCron("99 99 * * *").ok).toBe(false);
  });
  it("accepts valid cron", () => {
    expect(validateCron("0 2 * * *").ok).toBe(true);
  });
  it("validates timezones", () => {
    expect(validateTimezone("UTC")).toBe(true);
    expect(validateTimezone("America/New_York")).toBe(true);
    expect(validateTimezone("Not/AZone")).toBe(false);
  });
  it("next slot is strictly after", () => {
    const expr = "0 * * * *";
    const after = 1700000000;
    const nxt = nextSlotAfter(expr, "UTC", after);
    expect(nxt).toBeGreaterThan(after);
    const nxt2 = nextSlotAfter(expr, "UTC", nxt);
    expect(nxt2).toBeGreaterThan(nxt);
  });
  it("timezone shifts slots", () => {
    const utc = nextSlotAfter("0 9 * * *", "UTC", 1700000000);
    const ny = nextSlotAfter("0 9 * * *", "America/New_York", 1700000000);
    expect(utc).not.toBe(ny);
  });
  it("advance-expected skips past-grace slots after long outage", () => {
    // every 5 min, grace 5: outage of 2h → next expected must be in the future
    const now = 1700000000;
    const oldSlot = now - 7200;
    const nxt = advanceExpected("*/5 * * * *", "UTC", oldSlot, now, 5);
    expect(nxt + 5 * 60).toBeGreaterThan(now);
  });
  it("advance-expected from on-time ping gives the next slot", () => {
    const now = 1700000000;
    const slot = now - 60;
    const nxt = advanceExpected("*/5 * * * *", "UTC", slot, now, 5);
    expect(nxt).toBeGreaterThan(now);
  });
  it("describeCron gives plain English", () => {
    expect(describeCron("0 2 * * *")).toMatch(/02:00/i);
  });
  it("next3Slots returns 3 ascending times", () => {
    const r = next3Slots("*/5 * * * *", "UTC", 1700000000);
    expect(r).toHaveLength(3);
    expect(r[0]).toBeLessThan(r[1]);
    expect(r[1]).toBeLessThan(r[2]);
  });
});

// ---------- checker (7) ----------
describe("checker", () => {
  it("marks LATE inside grace, no alert", () => {
    const id = mkMonitor({ cron_expression: "* * * * *", grace_minutes: 5 });
    const now = nowSeconds();
    db.prepare("UPDATE monitors SET status='HEALTHY', next_expected_at=? WHERE id=?").run(now - 60, id);
    const r = runCheckerPass(now, db);
    const m = db.prepare("SELECT status FROM monitors WHERE id=?").get(id) as { status: string };
    expect(m.status).toBe("LATE");
    expect(r.late).toBe(1);
    const alerts = db.prepare("SELECT COUNT(*) as c FROM alerts").get() as { c: number };
    expect(alerts.c).toBe(0);
  });
  it("marks MISSED after grace with alert", () => {
    const id = mkMonitor({ cron_expression: "* * * * *", grace_minutes: 5 });
    const now = nowSeconds();
    db.prepare("UPDATE monitors SET status='HEALTHY', next_expected_at=? WHERE id=?").run(now - 600, id);
    runCheckerPass(now, db);
    const m = db.prepare("SELECT status, open_incident FROM monitors WHERE id=?").get(id) as { status: string; open_incident: string };
    expect(m.status).toBe("MISSED");
    expect(m.open_incident).toBe("MISSED");
  });
  it("marks RUNAWAY after max runtime", () => {
    const id = mkMonitor({ max_runtime_minutes: 20 });
    const now = nowSeconds();
    handleStartPing(id, now - 30 * 60, db);
    runCheckerPass(now, db);
    const m = db.prepare("SELECT status FROM monitors WHERE id=?").get(id) as { status: string };
    expect(m.status).toBe("RUNAWAY");
  });
  it("MISSED and RUNAWAY are sticky", () => {
    const now = nowSeconds();
    const a = mkMonitor();
    const b = mkMonitor();
    db.prepare("UPDATE monitors SET status='MISSED', open_incident='MISSED' WHERE id=?").run(a);
    db.prepare("UPDATE monitors SET status='RUNAWAY', open_incident='RUNAWAY' WHERE id=?").run(b);
    runCheckerPass(now, db);
    const ma = db.prepare("SELECT status FROM monitors WHERE id=?").get(a) as { status: string };
    const mb = db.prepare("SELECT status FROM monitors WHERE id=?").get(b) as { status: string };
    expect(ma.status).toBe("MISSED");
    expect(mb.status).toBe("RUNAWAY");
  });
  it("ignores paused monitors", () => {
    const id = mkMonitor();
    const now = nowSeconds();
    db.prepare("UPDATE monitors SET paused=1, status='PAUSED', next_expected_at=? WHERE id=?").run(now - 99999, id);
    runCheckerPass(now, db);
    const m = db.prepare("SELECT status FROM monitors WHERE id=?").get(id) as { status: string };
    expect(m.status).toBe("PAUSED");
  });
  it("each monitor uses its own grace", () => {
    const now = nowSeconds();
    const strict = mkMonitor({ grace_minutes: 1 });
    const lax = mkMonitor({ grace_minutes: 60 });
    for (const id of [strict, lax]) {
      db.prepare("UPDATE monitors SET status='HEALTHY', next_expected_at=? WHERE id=?").run(now - 300, id);
    }
    runCheckerPass(now, db);
    const s = db.prepare("SELECT status FROM monitors WHERE id=?").get(strict) as { status: string };
    const l = db.prepare("SELECT status FROM monitors WHERE id=?").get(lax) as { status: string };
    expect(s.status).toBe("MISSED");
    expect(l.status).toBe("LATE");
  });
  it("saves worker heartbeat", () => {
    const now = nowSeconds();
    runCheckerPass(now, db);
    const hb = db.prepare("SELECT value FROM meta WHERE key='worker_heartbeat'").get() as { value: string };
    expect(Number(hb.value)).toBeGreaterThanOrEqual(now);
  });
});

// ---------- alerts (9) ----------
describe("alerts", () => {
  it("alerts once per incident", () => {
    const id = mkMonitor();
    const a1 = queueIncidentAlert(id, "FAILED", "FAILED", "boom", db);
    const a2 = queueIncidentAlert(id, "FAILED", "FAILED", "boom again", db);
    expect(a1).not.toBeNull();
    expect(a2).toBeNull();
    const c = db.prepare("SELECT COUNT(*) as c FROM alerts").get() as { c: number };
    expect(c.c).toBe(1);
  });
  it("queues RECOVERED on recovery", () => {
    const id = mkMonitor();
    queueIncidentAlert(id, "FAILED", "FAILED", "boom", db);
    const r = queueRecoveryAlert(id, "recovered", db);
    expect(r).not.toBeNull();
    const row = db.prepare("SELECT alert_type FROM alerts WHERE id=?").get(r) as { alert_type: string };
    expect(row.alert_type).toBe("RECOVERED");
    const m = db.prepare("SELECT status, open_incident FROM monitors WHERE id=?").get(id) as { status: string; open_incident: string | null };
    expect(m.status).toBe("HEALTHY");
    expect(m.open_incident).toBeNull();
  });
  it("marks SKIPPED without channel", () => {
    const id = mkMonitor({ alert_channel_type: null });
    const a = queueIncidentAlert(id, "MISSED", "MISSED", "missed", db);
    const row = db.prepare("SELECT delivery_status FROM alerts WHERE id=?").get(a) as { delivery_status: string };
    expect(row.delivery_status).toBe("SKIPPED");
  });
  it("demo channel is delivered without network", async () => {
    const id = mkMonitor({ alert_channel_type: "demo" });
    const a = queueIncidentAlert(id, "FAILED", "FAILED", "boom", db);
    const row = db.prepare("SELECT delivery_status FROM alerts WHERE id=?").get(a) as { delivery_status: string };
    expect(row.delivery_status).toBe("DELIVERED");
    const sent = await sendPendingAlerts({ fetchFn: async () => { throw new Error("must not call network"); } }, db);
    expect(sent).toBe(0);
  });
  it("retries then fails finally", async () => {
    process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
    const id = mkMonitor({ alert_channel_type: "webhook", alert_channel_url: "http://127.0.0.1:9/hook" });
    db.prepare("UPDATE monitors SET status='FAILED', open_incident='FAILED' WHERE id=?").run(id);
    const now = nowSeconds();
    db.prepare(
      "INSERT INTO alerts(monitor_id, alert_type, message, delivery_status, attempts, next_try_at, created_at) VALUES(?, 'FAILED', 'x', 'PENDING', 0, ?, ?)"
    ).run(id, now, now);
    const failFetch = async () => { throw new Error("down"); };
    await sendPendingAlerts({ fetchFn: failFetch as never, nowSec: now }, db);
    await sendPendingAlerts({ fetchFn: failFetch as never, nowSec: now + 400 }, db);
    await sendPendingAlerts({ fetchFn: failFetch as never, nowSec: now + 900 }, db);
    const row = db.prepare("SELECT delivery_status, attempts FROM alerts ORDER BY id DESC LIMIT 1").get() as { delivery_status: string; attempts: number };
    expect(row.delivery_status).toBe("FAILED");
    expect(row.attempts).toBe(3);
    delete process.env.ALLOW_PRIVATE_WEBHOOKS;
  });
  it("delivers via fetch on success", async () => {
    process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
    const id = mkMonitor({ alert_channel_type: "slack", alert_channel_url: "http://127.0.0.1:9/hook" });
    db.prepare("UPDATE monitors SET status='FAILED', open_incident='FAILED' WHERE id=?").run(id);
    const now = nowSeconds();
    db.prepare(
      "INSERT INTO alerts(monitor_id, alert_type, message, delivery_status, attempts, next_try_at, created_at) VALUES(?, 'FAILED', 'x', 'PENDING', 0, ?, ?)"
    ).run(id, now, now);
    const okFetch = async () => new Response("ok", { status: 200 });
    const sent = await sendPendingAlerts({ fetchFn: okFetch as never, nowSec: now }, db);
    expect(sent).toBe(1);
    delete process.env.ALLOW_PRIVATE_WEBHOOKS;
  });
  it("slack vs discord body shape", () => {
    expect(slackBody("hi")).toEqual({ text: "hi" });
    expect(discordBody("hi")).toEqual({ content: "hi" });
    expect("text" in discordBody("hi")).toBe(false);
  });
  it("webhook body is structured with 20-line tail", () => {
    const tail = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const b = webhookBody({ monitorName: "m", slug: "s", alertType: "FAILED", exitCode: 3, logTail: tail, timestamp: 1 }) as Record<string, unknown>;
    expect(b.monitor_name).toBe("m");
    expect(b.exit_code).toBe(3);
    expect((b.log_tail as string).split("\n")).toHaveLength(20);
  });
  it("rejects unsafe webhook URLs at save time", async () => {
    expect((await checkWebhookUrlSafe("http://example.com/hook")).ok).toBe(false);
    expect((await checkWebhookUrlSafe("not a url")).ok).toBe(false);
    expect((await checkWebhookUrlSafe("https://localhost/hook")).ok).toBe(false);
  });
  it("message format has icon, name and exit code", () => {
    const s = formatAlertMessage("Billing", "FAILED", 137);
    expect(s).toContain("Billing");
    expect(s).toContain("137");
    expect(formatAlertMessage("Billing", "RECOVERED", 0)).toMatch(/✅/);
  });
});

// ---------- pings (9) ----------
describe("pings", () => {
  it("start then finish succeeds", () => {
    const id = mkMonitor();
    const now = nowSeconds();
    handleStartPing(id, now, db);
    const r = handleFinishPing(id, { exitCode: 0, output: "ok", kind: "finish" }, now + 5, db);
    expect(r.status).toBe("HEALTHY");
  });
  it("failure exit code marks FAILED", () => {
    const id = mkMonitor();
    const now = nowSeconds();
    handleStartPing(id, now, db);
    const r = handleFinishPing(id, { exitCode: 3, output: "boom", kind: "finish" }, now + 5, db);
    expect(r.status).toBe("FAILED");
  });
  it("fail forces exit 0 to 1", () => {
    const id = mkMonitor();
    const r = handleFinishPing(id, { exitCode: 0, output: "", kind: "fail" }, nowSeconds(), db);
    expect(r.status).toBe("FAILED");
  });
  it("heartbeat without start records a run", () => {
    const id = mkMonitor();
    const r = handleFinishPing(id, { exitCode: null, output: "", kind: "heartbeat" }, nowSeconds(), db);
    expect(r.status).toBe("HEALTHY");
    const c = db.prepare("SELECT COUNT(*) as c FROM executions WHERE monitor_id=?").get(id) as { c: number };
    expect(c.c).toBe(1);
  });
  it("second start abandons the older run", () => {
    const id = mkMonitor();
    const now = nowSeconds();
    handleStartPing(id, now, db);
    handleStartPing(id, now + 10, db);
    const rows = db.prepare("SELECT status FROM executions WHERE monitor_id=? ORDER BY id").all(id) as Array<{ status: string }>;
    expect(rows[0].status).toBe("ABANDONED");
    expect(rows[1].status).toBe("RUNNING");
  });
  it("unknown token finds nothing", () => {
    expect(findMonitorByToken("nope-not-a-token", db)).toBeUndefined();
  });
  it("rate limit blocks past 60/min", () => {
    const t = "tok123";
    const now = nowSeconds();
    for (let i = 0; i < 60; i++) expect(checkRateLimit(t, now)).toBe(true);
    expect(checkRateLimit(t, now)).toBe(false);
  });
  it("output is sanitized before storage", () => {
    const id = mkMonitor();
    handleFinishPing(id, { exitCode: 0, output: "x password=hunter2 y", kind: "finish" }, nowSeconds(), db);
    const row = db.prepare("SELECT sanitized_output FROM executions WHERE monitor_id=? ORDER BY id DESC LIMIT 1").get(id) as { sanitized_output: string };
    expect(row.sanitized_output).not.toContain("hunter2");
    expect(row.sanitized_output).toContain("[REDACTED_SECRET]");
  });
  it("body over 256KB is rejected", async () => {
    const big = "x".repeat(257 * 1024);
    const req = new Request("http://t/", { method: "POST", body: big });
    const { tooLarge } = await readPingBody(req);
    expect(tooLarge).toBe(true);
  });
  it("exit code resolution defaults", () => {
    expect(resolveExitCode(null, "finish")).toBe(0);
    expect(resolveExitCode(null, "fail")).toBe(1);
    expect(resolveExitCode("abc", "finish")).toBe(1);
    expect(resolveExitCode(0, "fail")).toBe(1);
  });
});

// ---------- misc (5) ----------
describe("misc", () => {
  it("isPublicIp rejects private ranges", () => {
    expect(isPublicIp("10.0.0.1")).toBe(false);
    expect(isPublicIp("192.168.1.1")).toBe(false);
    expect(isPublicIp("172.16.0.1")).toBe(false);
    expect(isPublicIp("127.0.0.1")).toBe(false);
    expect(isPublicIp("::1")).toBe(false);
    expect(isPublicIp("8.8.8.8")).toBe(true);
  });
  it("constant-time compare", () => {
    expect(timingSafeCompare("abc", "abc")).toBe(true);
    expect(timingSafeCompare("abc", "abd")).toBe(false);
    expect(timingSafeCompare("abc", "abcd")).toBe(false);
  });
  it("parses basic auth", () => {
    const h = "Basic " + Buffer.from("admin:s3cret").toString("base64");
    expect(parseBasicAuth(h)).toEqual({ user: "admin", pass: "s3cret" });
    expect(parseBasicAuth("Bearer x")).toBeNull();
  });
  it("resume resets to PENDING with fresh expectation", async () => {
    const { resumeMonitor } = await import("@/lib/monitors");
    const id = mkMonitor();
    const now = nowSeconds();
    db.prepare("UPDATE monitors SET status='MISSED', open_incident='MISSED', next_expected_at=? WHERE id=?").run(now - 9999, id);
    resumeMonitor(id, db);
    const m = db.prepare("SELECT status, open_incident, next_expected_at FROM monitors WHERE id=?").get(id) as { status: string; open_incident: string | null; next_expected_at: number };
    expect(m.status).toBe("PENDING");
    expect(m.open_incident).toBeNull();
    expect(m.next_expected_at).toBeGreaterThan(now);
  });
  it("success after failure sends RECOVERED", () => {
    const id = mkMonitor();
    const now = nowSeconds();
    handleStartPing(id, now, db);
    handleFinishPing(id, { exitCode: 1, output: "bad", kind: "finish" }, now + 1, db);
    handleStartPing(id, now + 2, db);
    handleFinishPing(id, { exitCode: 0, output: "good", kind: "finish" }, now + 3, db);
    const types = db.prepare("SELECT alert_type FROM alerts ORDER BY id").all() as Array<{ alert_type: string }>;
    expect(types.map((t) => t.alert_type)).toEqual(["FAILED", "RECOVERED"]);
  });
});
