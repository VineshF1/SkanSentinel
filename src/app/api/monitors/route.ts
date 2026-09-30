import { isAuthorized, unauthorizedResponse } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  createMonitor,
  validateMonitorInput,
  checkWebhookUrlSafe,
} from "@/lib/monitors";

export const runtime = "nodejs";

function publicMonitor(m: Record<string, unknown>): Record<string, unknown> {
  const { ping_token, alert_channel_url, ...rest } = m;
  void ping_token;
  void alert_channel_url;
  return rest;
}

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorized(req.headers.get("authorization")))
    return unauthorizedResponse();
  const dd = getDb();
  const rows = dd
    .prepare("SELECT * FROM monitors ORDER BY created_at DESC")
    .all() as Record<string, unknown>[];
  return Response.json({ monitors: rows.map(publicMonitor) });
}

export async function POST(req: Request): Promise<Response> {
  if (!isAuthorized(req.headers.get("authorization")))
    return unauthorizedResponse();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const input = {
    name: String(body.name ?? ""),
    slug: String(body.slug ?? ""),
    cron_expression: String(body.cron_expression ?? ""),
    timezone: String(body.timezone ?? "Asia/Kolkata"),
    grace_minutes: Number(body.grace_minutes ?? 5),
    max_runtime_minutes: Number(body.max_runtime_minutes ?? 30),
    alert_channel_type:
      body.alert_channel_type === undefined
        ? null
        : String(body.alert_channel_type),
    alert_channel_url:
      body.alert_channel_url === undefined
        ? null
        : String(body.alert_channel_url),
  };
  const v = validateMonitorInput(input);
  if (!v.ok) return Response.json({ errors: v.errors }, { status: 400 });
  // Webhook safety at save time.
  if (
    (input.alert_channel_type === "slack" ||
      input.alert_channel_type === "discord" ||
      input.alert_channel_type === "webhook") &&
    input.alert_channel_url
  ) {
    const safe = await checkWebhookUrlSafe(input.alert_channel_url);
    if (!safe.ok) {
      return Response.json(
        { errors: { alert_channel_url: safe.error ?? "Unsafe URL" } },
        { status: 400 }
      );
    }
  }
  const dd = getDb();
  const slugTaken = dd
    .prepare("SELECT id FROM monitors WHERE slug = ?")
    .get(input.slug.trim());
  if (slugTaken) {
    return Response.json(
      { errors: { slug: "Slug is already taken" } },
      { status: 400 }
    );
  }
  try {
    const { id } = createMonitor(input, dd);
    const row = dd
      .prepare("SELECT * FROM monitors WHERE id = ?")
      .get(id) as Record<string, unknown>;
    return Response.json({ monitor: publicMonitor(row) }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Create failed";
    if (msg.includes("UNIQUE")) {
      return Response.json(
        { errors: { slug: "Slug is already taken" } },
        { status: 400 }
      );
    }
    return Response.json({ error: msg }, { status: 500 });
  }
}
