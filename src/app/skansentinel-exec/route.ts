import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

const FALLBACK = `#!/bin/sh
# skansentinel-exec (fallback copy)
`;

export async function GET(): Promise<Response> {
  let body = FALLBACK;
  try {
    body = fs.readFileSync(path.join(process.cwd(), "skansentinel-exec"), "utf8");
  } catch {
    /* serve fallback */
  }
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": 'attachment; filename="skansentinel-exec"',
    },
  });
}
