import { isAuthorized, unauthorizedResponse } from "@/lib/auth";
import { resumeMonitor } from "@/lib/monitors";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isAuthorized(req.headers.get("authorization")))
    return unauthorizedResponse();
  const { id } = await ctx.params;
  resumeMonitor(Number(id));
  return Response.json({ ok: true });
}
