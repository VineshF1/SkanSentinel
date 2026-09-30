import { isAuthorized, unauthorizedResponse } from "@/lib/auth";
import { getDb, type MonitorRow } from "@/lib/db";
import { checkWebhookUrlSafe } from "@/lib/monitors";

export const runtime = "nodejs";

const TYPES = new Set(["none", "slack", "discord", "webhook"]);

export async function PATCH(
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

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawType = String(body.alert_channel_type ?? "");
  if (!TYPES.has(rawType)) {
    return Response.json(
      { errors: { alert_channel_type: "Unknown alert channel" } },
      { status: 400 }
    );
  }
  const needsUrl = rawType === "slack" || rawType === "discord" || rawType === "webhook";
  const rawUrl = String(body.alert_channel_url ?? "").trim();
  if (needsUrl && !rawUrl) {
    return Response.json(
      { errors: { alert_channel_url: "Webhook URL is required for this channel" } },
      { status: 400 }
    );
  }
  if (needsUrl) {
    const safe = await checkWebhookUrlSafe(rawUrl);
    if (!safe.ok) {
      return Response.json(
        { errors: { alert_channel_url: safe.error ?? "Unsafe URL" } },
        { status: 400 }
      );
    }
  }

  const chType = rawType === "none" ? null : rawType;
  const chUrl = needsUrl ? rawUrl : null;
  dd.prepare(
    "UPDATE monitors SET alert_channel_type = ?, alert_channel_url = ? WHERE id = ?"
  ).run(chType, chUrl, Number(id));
  const updated = dd
    .prepare("SELECT * FROM monitors WHERE id = ?")
    .get(Number(id)) as MonitorRow;
  const { alert_channel_url, ...rest } = updated;
  void alert_channel_url;
  return Response.json({ monitor: rest });
}
