import { NextRequest, NextResponse } from "next/server";

// Edge-safe: no node: imports here. Constant-time compare over equal lengths.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function basicPassword(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith("Basic ")) return null;
  try {
    const decoded = atob(authHeader.slice(6));
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return decoded.slice(idx + 1);
  } catch {
    return null;
  }
}

const PUBLIC_PREFIXES = ["/api/ping", "/healthz", "/skansentinel-exec"];

export function middleware(req: NextRequest): NextResponse | Promise<NextResponse> {
  const path = req.nextUrl.pathname;
  if (
    PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p + "/")) ||
    path.startsWith("/_next/") ||
    path === "/favicon.ico"
  ) {
    return NextResponse.next();
  }
  const expected = process.env.ADMIN_PASSWORD ?? "";
  if (!expected) {
    return new NextResponse("Server misconfigured", { status: 500 });
  }
  const got = basicPassword(req.headers.get("authorization"));
  if (got !== null && safeEqual(got, expected)) {
    return NextResponse.next();
  }
  // Slow down brute force with a delayed 401.
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(
        new NextResponse("Authentication required", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="SkanSentinel"' },
        })
      );
    }, 300);
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
