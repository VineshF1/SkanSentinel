import {
  findMonitorByToken,
  checkRateLimit,
  handleFinishPing,
} from "@/lib/engine";
import { nowSeconds } from "@/lib/time";
import {
  readPingBody,
  exitCodeFromQuery,
} from "@/lib/ping-request";

export const runtime = "nodejs";

async function finish(
  req: Request,
  token: string,
  kind: "finish" | "fail"
): Promise<Response> {
  const m = findMonitorByToken(token);
  if (!m) return Response.json({ error: "Not found" }, { status: 404 });
  const now = nowSeconds();
  if (!checkRateLimit(token, now)) {
    return Response.json({ error: "Rate limited" }, { status: 429 });
  }
  if (m.paused) {
    return Response.json({ name: m.name, state: "PAUSED" });
  }
  const { parsed, tooLarge } = await readPingBody(req);
  if (tooLarge) {
    return Response.json({ error: "Body too large" }, { status: 413 });
  }
  const qExit = exitCodeFromQuery(req.url);
  const exitRaw = parsed.exitCode ?? qExit;
  const dur =
    parsed.duration === undefined || parsed.duration === null
      ? null
      : Number(parsed.duration);
  const { status } = handleFinishPing(
    m.id,
    {
      exitCode: exitRaw === null || exitRaw === undefined || exitRaw === "" ? null : (exitRaw as number),
      output: parsed.output,
      kind,
      durationSeconds: Number.isFinite(dur) ? (dur as number) : null,
    },
    now
  );
  return Response.json({ name: m.name, state: status });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> }
): Promise<Response> {
  const { token } = await ctx.params;
  return finish(req, token, "finish");
}
