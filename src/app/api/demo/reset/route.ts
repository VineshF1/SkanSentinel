import { isAuthorized, unauthorizedResponse } from "@/lib/auth";
import { isDemoMode } from "@/lib/config";
import { resetDemo } from "@/lib/demo";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  if (!isDemoMode()) return Response.json({ error: "Not found" }, { status: 404 });
  if (!isAuthorized(req.headers.get("authorization")))
    return unauthorizedResponse();
  resetDemo();
  return Response.json({ ok: true });
}
