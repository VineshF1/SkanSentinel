import { isAuthorized, unauthorizedResponse } from "@/lib/auth";
import { isDemoMode } from "@/lib/config";
import { simulateDemo, resetDemo, type SimulateKind } from "@/lib/demo";

export const runtime = "nodejs";

const KINDS: SimulateKind[] = ["crash", "missed", "hang", "leak"];

export async function POST(req: Request): Promise<Response> {
  if (!isDemoMode()) return Response.json({ error: "Not found" }, { status: 404 });
  if (!isAuthorized(req.headers.get("authorization")))
    return unauthorizedResponse();
  const url = new URL(req.url);
  if (url.pathname.endsWith("/reset")) {
    resetDemo();
    return Response.json({ ok: true });
  }
  let body: { monitorId?: number; kind?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.monitorId || !body.kind || !KINDS.includes(body.kind as SimulateKind)) {
    return Response.json({ error: "monitorId and kind (crash|missed|hang|leak) required" }, { status: 400 });
  }
  try {
    const r = simulateDemo(Number(body.monitorId), body.kind as SimulateKind);
    return Response.json({ ok: true, status: r.status });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Simulate failed" },
      { status: 400 }
    );
  }
}
