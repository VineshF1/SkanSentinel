import { isAuthorized, unauthorizedResponse } from "@/lib/auth";
import { getDb, type MonitorRow } from "@/lib/db";
import { deleteMonitor } from "@/lib/monitors";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isAuthorized(req.headers.get("authorization")))
    return unauthorizedResponse();
  const { id } = await ctx.params;
  const dd = getDb();
  const m = dd
    .prepare("SELECT * FROM monitors WHERE id = ?")
    .get(Number(id)) as MonitorRow | undefined;
  if (!m) return Response.json({ error: "Not found" }, { status: 404 });
  const { alert_channel_url, ...rest } = m;
  void alert_channel_url;
  const executions = dd
    .prepare(
      "SELECT id, status, scheduled_for, started_at, finished_at, duration_seconds, exit_code FROM executions WHERE monitor_id = ? ORDER BY id DESC LIMIT 30"
    )
    .all(Number(id));
  const latestLog = dd
    .prepare(
      "SELECT sanitized_output FROM executions WHERE monitor_id = ? ORDER BY id DESC LIMIT 1"
    )
    .get(Number(id)) as { sanitized_output: string | null } | undefined;
  return Response.json({
    monitor: rest,
    executions,
    latest_log: latestLog?.sanitized_output ?? null,
  });
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isAuthorized(req.headers.get("authorization")))
    return unauthorizedResponse();
  const { id } = await ctx.params;
  deleteMonitor(Number(id));
  return Response.json({ ok: true });
}
