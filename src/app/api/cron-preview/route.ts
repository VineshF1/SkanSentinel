import { isAuthorized, unauthorizedResponse } from "@/lib/auth";
import {
  validateCron,
  validateTimezone,
  describeCron,
  next3Slots,
} from "@/lib/schedule";
import { nowSeconds } from "@/lib/time";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorized(req.headers.get("authorization")))
    return unauthorizedResponse();
  const url = new URL(req.url);
  const expr = url.searchParams.get("expr") ?? "";
  const tz = url.searchParams.get("tz") ?? "Asia/Kolkata";
  const cv = validateCron(expr);
  if (!cv.ok)
    return Response.json({ ok: false, error: cv.error }, { status: 400 });
  if (!validateTimezone(tz))
    return Response.json({ ok: false, error: "Invalid timezone" });
  const now = nowSeconds();
  return Response.json({
    ok: true,
    text: describeCron(expr),
    next: next3Slots(expr, tz, now),
  });
}
