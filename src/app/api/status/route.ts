import { isAuthorized, unauthorizedResponse } from "@/lib/auth";
import { getDb, getWorkerHeartbeat, nowSeconds } from "@/lib/db";
import { isDemoMode } from "@/lib/config";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorized(req.headers.get("authorization")))
    return unauthorizedResponse();
  const dd = getDb();
  const monitors = dd
    .prepare(
      `SELECT id, name, slug, cron_expression, timezone, grace_minutes, max_runtime_minutes,
              status, paused, open_incident, last_ping_at, last_start_at, next_expected_at, created_at
       FROM monitors ORDER BY created_at DESC`
    )
    .all() as Array<{ status: string } & Record<string, unknown>>;
  const counts: Record<string, number> = {
    total: monitors.length,
    healthy: 0,
    running: 0,
    missed: 0,
    failed: 0,
    runaway: 0,
  };
  for (const m of monitors) {
    const k = String(m.status).toLowerCase();
    if (k in counts) counts[k]++;
  }
  const alerts = dd
    .prepare(
      `SELECT a.id, a.monitor_id, a.alert_type, a.message, a.delivery_status, a.created_at, m.name as monitor_name
       FROM alerts a JOIN monitors m ON m.id = a.monitor_id
       ORDER BY a.id DESC LIMIT 20`
    )
    .all();
  const now = nowSeconds();
  const hb = getWorkerHeartbeat(dd);
  return Response.json({
    counts,
    monitors,
    alerts,
    worker_heartbeat: hb,
    worker_offline: hb === null || now - hb > 30,
    now,
    demo_mode: isDemoMode(),
  });
}
