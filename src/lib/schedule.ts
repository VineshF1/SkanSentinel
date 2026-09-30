import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";

export function validateCron(expr: string): { ok: boolean; error?: string } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { ok: false, error: "Cron must have exactly 5 fields" };
  }
  try {
    CronExpressionParser.parse(expr, { tz: "UTC" });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Invalid cron" };
  }
}

export function validateTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function describeCron(expr: string): string {
  try {
    return cronstrue.toString(expr);
  } catch {
    return "Invalid schedule";
  }
}

function toEpochSec(cronDate: unknown): number {
  const c = cronDate as {
    toDate?: () => Date;
    getTime?: () => number;
    toString?: () => string;
  };
  if (c && typeof c.toDate === "function") {
    return Math.floor(c.toDate().getTime() / 1000);
  }
  return Math.floor(new Date(String(cronDate)).getTime() / 1000);
}

export function nextSlotAfter(
  expr: string,
  tz: string,
  afterSec: number
): number {
  const it = CronExpressionParser.parse(expr, {
    tz,
    currentDate: new Date(afterSec * 1000),
  });
  // strictly after: cron-parser next() is exclusive of currentDate
  return toEpochSec(it.next());
}

export function next3Slots(
  expr: string,
  tz: string,
  fromSec: number
): number[] {
  const it = CronExpressionParser.parse(expr, {
    tz,
    currentDate: new Date(fromSec * 1000),
  });
  const out: number[] = [];
  for (let i = 0; i < 3; i++) out.push(toEpochSec(it.next()));
  return out;
}

/**
 * After a finish/fail, compute the next expected time from the slot that was
 * just satisfied (not "now" alone), skipping slots already past their grace
 * window. Prevents instant false MISSED after a long outage and double-counting.
 */
export function advanceExpected(
  expr: string,
  tz: string,
  satisfiedSlotSec: number | null,
  nowSec: number,
  graceMinutes: number
): number {
  const graceSec = graceMinutes * 60;
  try {
    // One iterator, advanced slot by slot. Re-parsing per step cost ~500ms
    // per ping on frequent schedules; this keeps the same semantics.
    const it = CronExpressionParser.parse(expr, {
      tz,
      currentDate: new Date((satisfiedSlotSec ?? nowSec) * 1000),
    });
    // Guard against infinite loops: at most ~5000 slots scanned.
    for (let i = 0; i < 5000; i++) {
      const nxt = toEpochSec(it.next());
      if (nxt + graceSec > nowSec) return nxt;
    }
  } catch {
    /* fall through to fallback */
  }
  // Fallback: one slot after now.
  return nextSlotAfter(expr, tz, nowSec);
}

/** Find the most recent scheduled slot at or before nowSec (for drift calc). */
export function previousSlot(
  expr: string,
  tz: string,
  nowSec: number
): number | null {
  try {
    // Walk forward from 7 days ago with a single iterator. Re-parsing per
    // step cost ~500ms per ping on frequent schedules; same result, one parse.
    const it = CronExpressionParser.parse(expr, {
      tz,
      currentDate: new Date((nowSec - 7 * 86400) * 1000),
    });
    let prev: number | null = null;
    for (let i = 0; i < 20000; i++) {
      const nxt = toEpochSec(it.next());
      if (nxt > nowSec) break;
      prev = nxt;
    }
    return prev;
  } catch {
    return null;
  }
}
