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

async function heartbeat(req: Request, token: string): Promise<Response> {
  const m = findMonitorByToken(token);
  if (!m) return Response.json({ error: "Not found" }, { status: 404 });
  const now = nowSeconds();
  if (!checkRateLimit(token, now)) {
    return Response.json({ error: "Rate limited" }, { status: 429 });
  }
  if (m.paused) {
    return Response.json({ name: m.name, state: "PAUSED" });
  }
  let output = "";
  if (req.method === "POST") {
    const { parsed, tooLarge } = await readPingBody(req);
    if (tooLarge) {
      return Response.json({ error: "Body too large" }, { status: 413 });
    }
    output = parsed.output;
    const qExit = exitCodeFromQuery(req.url);
    const exitRaw = parsed.exitCode ?? qExit;
    const { status } = handleFinishPing(
      m.id,
      {
        exitCode:
          exitRaw === null || exitRaw === undefined || exitRaw === ""
            ? null
            : (exitRaw as number),
        output,
        kind: "heartbeat",
      },
      now
    );
    return Response.json({ name: m.name, state: status });
  }
  const qExit = exitCodeFromQuery(req.url);
  const { status } = handleFinishPing(
    m.id,
    {
      exitCode:
        qExit === null || qExit === undefined || qExit === ""
          ? null
          : (qExit as number),
      output: "",
      kind: "heartbeat",
    },
    now
  );
  return Response.json({ name: m.name, state: status });
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ token: string }> }
): Promise<Response> {
  const { token } = await ctx.params;
  return heartbeat(req, token);
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> }
): Promise<Response> {
  const { token } = await ctx.params;
  return heartbeat(req, token);
}
