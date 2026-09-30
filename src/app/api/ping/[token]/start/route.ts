import {
  findMonitorByToken,
  checkRateLimit,
  handleStartPing,
} from "@/lib/engine";
import { nowSeconds } from "@/lib/time";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> }
): Promise<Response> {
  const { token } = await ctx.params;
  const m = findMonitorByToken(token);
  if (!m) return Response.json({ error: "Not found" }, { status: 404 });
  const now = nowSeconds();
  if (!checkRateLimit(token, now)) {
    return Response.json({ error: "Rate limited" }, { status: 429 });
  }
  if (m.paused) {
    return Response.json({ name: m.name, state: "PAUSED" });
  }
  handleStartPing(m.id, now);
  return Response.json({ name: m.name, state: "RUNNING" });
}
