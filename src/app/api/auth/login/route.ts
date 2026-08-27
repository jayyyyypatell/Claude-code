import { getSession, passwordMatches } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Exchange the passphrase for a session cookie.
 *
 * A plain form POST rather than JSON, so it works with the browser's password
 * manager and without JavaScript.
 */
export async function POST(req: Request): Promise<Response> {
  const form = await req.formData();
  const password = String(form.get("password") ?? "");

  // Only same-origin relative paths, or this is an open redirect: an attacker
  // could send someone a login link that bounces them to a lookalike site
  // after a successful login.
  const requested = String(form.get("next") ?? "/");
  const next =
    requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";

  if (!passwordMatches(password)) {
    return Response.redirect(new URL("/login?error=1", req.url), 303);
  }

  const session = await getSession();
  session.authenticated = true;
  session.createdAt = Date.now();
  await session.save();

  return Response.redirect(new URL(next, req.url), 303);
}
