import { timingSafeEqual, scryptSync, randomBytes } from "node:crypto";

import { getIronSession, type SessionOptions } from "iron-session";
import { cookies, headers } from "next/headers";

import { cookieSecureForRequest } from "@/lib/net/host";

/**
 * Single-user authentication.
 *
 * This app holds a complete health history — every night's sleep, every
 * workout, a journal, and location data if routes are ever enabled. Once it is
 * reachable from a phone it is reachable from the internet, and an unprotected
 * instance is a complete medical record served to anyone who finds the URL.
 *
 * So it is one passphrase and an encrypted cookie. Not because that is
 * sophisticated, but because it is the smallest thing that actually closes the
 * hole, and something you will actually set up beats an OAuth flow you won't.
 *
 * `/api/ingest/hae` is deliberately exempt — the phone can't log in, so it
 * carries its own bearer token instead.
 */

export interface Session {
  authenticated?: boolean;
  createdAt?: number;
}

/** Iron-session requires 32+ chars; a short one throws rather than weakening. */
function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "SESSION_SECRET must be set and at least 32 characters. Generate one:\n" +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return secret;
}

export function sessionOptions(secure: boolean): SessionOptions {
  return {
    password: sessionSecret(),
    cookieName: "life_session",
    cookieOptions: {
      // Not readable from JavaScript, so an XSS bug can't lift the session.
      httpOnly: true,
      // Decided per request rather than from NODE_ENV: the same production
      // build serves a LAN address over plain HTTP and a hosted domain over
      // HTTPS, and a Secure cookie on the former is silently discarded by the
      // browser — login appears to succeed and never sticks, which reads as a
      // wrong passphrase. See `cookieSecureForRequest`.
      secure,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
      path: "/",
    },
  };
}

export async function getSession() {
  const [store, h] = await Promise.all([cookies(), headers()]);
  return getIronSession<Session>(
    store,
    sessionOptions(
      cookieSecureForRequest(h.get("host"), h.get("x-forwarded-proto")),
    ),
  );
}

/**
 * The session gate for anything the `(app)` layout doesn't wrap.
 *
 * Route handlers and server actions run outside that layout, so its check
 * never fires for them — leaving only `proxy.ts`, which by design verifies
 * that a cookie *exists* rather than that it is valid. Without this, a forged
 * `life_session` cookie reads the entire health history through the coach's
 * tool layer, which is a far worse hole than the flash of empty dashboard the
 * proxy exists to prevent.
 */
export async function sessionOk(): Promise<boolean> {
  if (!authEnabled()) return true;
  return Boolean((await getSession()).authenticated);
}

/**
 * Whether auth is switched on at all.
 *
 * Without APP_PASSWORD the app runs open, which is right for local
 * development and wrong for anything reachable. The settings page says so
 * loudly rather than letting it pass unnoticed.
 */
export function authEnabled(): boolean {
  return Boolean(process.env.APP_PASSWORD);
}

/**
 * Constant-time passphrase check.
 *
 * The passphrase is compared through scrypt rather than directly, so the
 * comparison is over fixed-length derived keys — a raw comparison of the
 * plaintext would leak length, and a fast hash would make guessing cheap.
 */
export function passwordMatches(provided: string): boolean {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return false;

  // A fixed salt is fine here: this is one local credential compared against
  // itself, not a stored password database. The salt's job is only to make
  // both sides the same fixed length for a constant-time compare.
  const salt = "life-tracker-session";
  const a = scryptSync(provided, salt, 32);
  const b = scryptSync(expected, salt, 32);
  return timingSafeEqual(a, b);
}

/** Suggest a secret in the settings UI when one isn't configured. */
export function suggestSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Routes reachable without a session. */
export const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  // The phone can't log in; it authenticates with INGEST_TOKEN instead.
  "/api/ingest",
  "/manifest.webmanifest",
  "/sw.js",
  "/icons",
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}
