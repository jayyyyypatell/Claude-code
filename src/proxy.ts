import { NextResponse, type NextRequest } from "next/server";

/**
 * Redirect unauthenticated requests to the login page.
 *
 * Renamed from `middleware.ts`, which Next 16 deprecated in favour of
 * `proxy.ts`.
 *
 * This is a **convenience, not the enforcement**. It only checks that a
 * session cookie exists — it does not decrypt or verify it, because the proxy
 * runs in a restricted runtime and shouldn't carry the session secret. The
 * real gate is `requireSession()` in the (app) layout, which runs where the
 * data is actually read. Proxy-only authentication has a poor track record
 * precisely because it can be routed around; this exists so an unauthenticated
 * visitor gets a login page instead of a flash of empty dashboard.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isPublic =
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/auth") ||
    // The phone can't log in; it carries INGEST_TOKEN instead.
    pathname.startsWith("/api/ingest") ||
    pathname.startsWith("/icons") ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/sw.js";

  if (isPublic) return NextResponse.next();

  const hasCookie = request.cookies.has("life_session");
  if (!hasCookie) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Everything except Next's own assets and the favicon.
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
