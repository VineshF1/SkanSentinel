import crypto from "node:crypto";
import { adminPassword } from "./config";

export function timingSafeCompare(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Compare anyway against same-length buffer to keep timing stable.
    const dummy = Buffer.alloc(Math.max(ab.length, bb.length));
    try {
      crypto.timingSafeEqual(dummy, dummy);
    } catch {
      /* ignore */
    }
    return false;
  }
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

export function parseBasicAuth(
  header: string | null
): { user: string; pass: string } | null {
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

export function isAuthorized(authHeader: string | null): boolean {
  const expected = adminPassword();
  if (!expected) return false;
  const creds = parseBasicAuth(authHeader);
  if (!creds) return false;
  return timingSafeCompare(creds.pass, expected);
}

export function unauthorizedResponse(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="SkanSentinel"' },
  });
}
