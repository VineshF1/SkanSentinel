import { isAuthorized, unauthorizedResponse } from "@/lib/auth";
import { pauseMonitor, resumeMonitor } from "@/lib/monitors";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isAuthorized(req.headers.get("authorization")))
    return unauthorizedResponse();
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const action = url.pathname.endsWith("/resume") ? "resume" : "pause";
  if (action === "resume") resumeMonitor(Number(id));
  else pauseMonitor(Number(id));
  return Response.json({ ok: true });
}
