export const MAX_BODY_BYTES = 256 * 1024;

export interface ParsedPing {
  exitCode: unknown;
  output: string;
  error?: string;
  duration?: unknown;
}

/** Read body with a 256KB cap. Returns 413 flag when exceeded. */
export async function readPingBody(req: Request): Promise<{
  parsed: ParsedPing;
  tooLarge: boolean;
}> {
  const lenHeader = req.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
    return { parsed: { exitCode: undefined, output: "" }, tooLarge: true };
  }
  let raw = "";
  try {
    raw = await req.text();
  } catch {
    raw = "";
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return { parsed: { exitCode: undefined, output: "" }, tooLarge: true };
  }
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json") && raw.trim()) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      const parts: string[] = [];
      if (typeof j.output === "string") parts.push(j.output);
      if (typeof j.errorMessage === "string" && j.errorMessage)
        parts.push(j.errorMessage);
      return {
        parsed: {
          exitCode: j.exitCode ?? j.exit_code,
          output: parts.join("\n"),
          duration: j.duration,
        },
        tooLarge: false,
      };
    } catch {
      // Fall through: treat as plain text.
    }
  }
  return { parsed: { exitCode: undefined, output: raw }, tooLarge: false };
}

export function exitCodeFromQuery(url: string): unknown {
  try {
    const u = new URL(url);
    return u.searchParams.get("exit_code");
  } catch {
    return undefined;
  }
}
