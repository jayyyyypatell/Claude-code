import { NextResponse, type NextRequest } from "next/server";

import { exposureVerdict } from "@/lib/net/host";

/**
 * Two jobs, in order: refuse to serve an unprotected instance to the network,
 * and send unauthenticated visitors to the login page.
 *
 * Renamed from `middleware.ts`, which Next 16 deprecated in favour of
 * `proxy.ts`.
 *
 * The login redirect is a **convenience, not the enforcement**. It only checks
 * that a session cookie exists — it does not decrypt or verify it, because the
 * proxy shouldn't carry the session secret. The real gate is in the (app)
 * layout, and in `sessionOk()` for the routes that layout doesn't wrap.
 * Proxy-only authentication has a poor track record precisely because it can
 * be routed around; this exists so an unauthenticated visitor gets a login
 * page instead of a flash of empty dashboard.
 */

/**
 * Shown when the app is reachable from off this machine with no passphrase set.
 *
 * Plain text and a 403 rather than a redirect: there is no passphrase to type,
 * so `/login` would be a dead end, and the person reading this needs the
 * sentence more than they need a styled page.
 */
const LOCKOUT = `This copy of Life is reachable from your network but has no passphrase set.

Refusing to serve it. It holds a complete health history, and every device on
this network — guests included — can reach this address.

To fix it, run:   npm run setup

Or open it from the machine it runs on, at http://localhost:3000
`;

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // The phone can't log in and carries INGEST_TOKEN instead, so ingest is
  // exempt from both checks below — it is the one path that is *supposed* to
  // be reached from another device without a session.
  if (pathname.startsWith("/api/ingest")) return NextResponse.next();

  // Read directly rather than importing `authEnabled()` from `@/lib/auth`:
  // that module pulls in iron-session and next/headers, neither of which
  // belongs in the proxy. Kept deliberately as the same one-line test.
  const authEnabled = Boolean(process.env.APP_PASSWORD);

  const verdict = exposureVerdict({
    host: request.headers.get("host"),
    authEnabled,
    allowInsecure: process.env.ALLOW_INSECURE_LAN === "1",
  });
  if (verdict === "blocked") {
    return new NextResponse(LOCKOUT, {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // With no APP_PASSWORD there is nothing to log into. Redirecting anyway sent
  // every request to /login, which redirects straight back to / because no
  // form there could ever succeed — a loop the browser reports as
  // ERR_TOO_MANY_REDIRECTS on the first page load of a fresh clone.
  if (!authEnabled) return NextResponse.next();

  const isPublic =
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/auth") ||
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
