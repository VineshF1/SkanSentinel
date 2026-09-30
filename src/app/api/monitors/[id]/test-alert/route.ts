import { isAuthorized, unauthorizedResponse } from "@/lib/auth";
import { getDb, nowSeconds, type MonitorRow } from "@/lib/db";
import { checkWebhookUrlSafe } from "@/lib/monitors";
import { sanitizeText } from "@/lib/sanitizer";
import { slackBody, discordBody } from "@/lib/alerts";

export const runtime = "nodejs";

/**
 * Posts a test message through the monitor's saved channel right now and
 * reports the result. Nothing is queued or stored; the URL is used once.
 */
export async function POST(
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
  if (!m.alert_channel_type || !m.alert_channel_url) {
    return Response.json(
      { error: "No alert channel saved for this monitor" },
      { status: 400 }
    );
  }
  const safe = await checkWebhookUrlSafe(m.alert_channel_url);
  if (!safe.ok) {
    return Response.json(
      { error: safe.error ?? "Unsafe URL" },
      { status: 400 }
    );
  }
  const text = sanitizeText(
    `SkanSentinel test message for ${m.name}: your channel works.`
  ).slice(0, 500);
  const body =
    m.alert_channel_type === "slack"
      ? slackBody(text)
      : m.alert_channel_type === "discord"
        ? discordBody(text)
        : {
            test: true,
            monitor_name: m.name,
            slug: m.slug,
            message: text,
            timestamp: nowSeconds(),
          };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(m.alert_channel_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const reply = (await res.text()).slice(0, 120);
    if (res.ok) return Response.json({ ok: true, reply });
    return Response.json(
      { error: `Channel answered HTTP ${res.status}: ${reply || "no detail"}` },
      { status: 502 }
    );
  } catch {
    return Response.json(
      { error: "Channel unreachable (timeout or network error)" },
      { status: 502 }
    );
  }
}
