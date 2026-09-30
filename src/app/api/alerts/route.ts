import { isAuthorized, unauthorizedResponse } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorized(req.headers.get("authorization")))
    return unauthorizedResponse();
  const dd = getDb();
  const rows = dd
    .prepare(
      `SELECT a.id, a.monitor_id, a.alert_type, a.message, a.delivery_status, a.attempts, a.created_at, a.sent_at, m.name as monitor_name
       FROM alerts a JOIN monitors m ON m.id = a.monitor_id
       ORDER BY a.id DESC LIMIT 50`
    )
    .all();
  return Response.json({ alerts: rows });
}
