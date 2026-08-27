/**
 * Deciding what a request's host implies about how exposed this instance is.
 *
 * Three separate questions in the app turn out to be the same question:
 * whether the session cookie may be marked `Secure`, whether an unauthenticated
 * visitor should be served data, and what the setup script should print as the
 * phone's URL. All three come down to "is this address reachable from beyond
 * this machine, and is it plausibly carrying TLS".
 *
 * **These are a safety interlock, not an authorization boundary.** The `Host`
 * header is written by the client, so anyone who can already reach a
 * non-loopback socket can claim to be `localhost` and slip past
 * `exposureVerdict`. That is understood and accepted: the real boundary is the
 * bind address plus the passphrase, enforced before the server starts (see
 * `scripts/lan.mjs`). This layer exists to catch the case where someone ran
 * `next dev -H 0.0.0.0` by hand and skipped that check — the same reasoning
 * `proxy.ts` gives for its own cookie check.
 */

/** `192.168.1.5:3000` → `192.168.1.5`; `[::1]:3000` → `::1`. */
export function hostnameOf(host: string | null | undefined): string | null {
  if (!host) return null;
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return null;

  // Bracketed IPv6 carries colons of its own, so the port split has to happen
  // after the bracket rather than at the first colon.
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    return close === -1 ? trimmed.slice(1) : trimmed.slice(1, close);
  }

  // A bare IPv6 address has several colons; only a host:port has exactly one.
  const firstColon = trimmed.indexOf(":");
  if (firstColon === -1) return trimmed;
  if (trimmed.indexOf(":", firstColon + 1) !== -1) return trimmed;
  return trimmed.slice(0, firstColon);
}

export function isLoopbackHost(host: string | null | undefined): boolean {
  const name = hostnameOf(host);
  if (!name) return false;
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name === "::1" || name === "0:0:0:0:0:0:0:1") return true;
  // The whole 127/8 block, not just 127.0.0.1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return true;
  // Not a real destination, but it is what a server bound to every interface
  // reports about itself, and treating it as remote would be misleading.
  if (name === "0.0.0.0" || name === "::") return true;
  return false;
}

/**
 * An address that cannot be a public deployment.
 *
 * Loopback, RFC1918, link-local, unique-local IPv6, and mDNS `.local` names.
 * Used to decide that a missing TLS terminator means plain HTTP rather than a
 * misconfiguration.
 */
export function isPrivateHost(host: string | null | undefined): boolean {
  const name = hostnameOf(host);
  if (!name) return false;
  if (isLoopbackHost(name)) return true;

  // Bonjour. This is how the Mac is reached from an iPhone on the same WiFi.
  if (name === "local" || name.endsWith(".local")) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    // 172.16.0.0/12 is 172.16 through 172.31 — 172.32 is public, and getting
    // this boundary wrong is the classic way to leak a Secure-cookie downgrade
    // onto a real host.
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(name)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(name)) return true;

  return false;
}

/**
 * Whether the session cookie may carry `Secure` for this request.
 *
 * A `Secure` cookie is silently discarded by the browser over plain HTTP, so
 * getting this wrong doesn't fail loudly — login simply never sticks, which
 * looks like a wrong passphrase. It has to be decided per request rather than
 * from `NODE_ENV`, because the same production build serves both a LAN address
 * over HTTP and a hosted domain over HTTPS.
 */
export function cookieSecureForRequest(
  host: string | null | undefined,
  forwardedProto: string | null | undefined,
): boolean {
  // Trust `x-forwarded-proto` only when it claims HTTPS. A forged `http` on a
  // real TLS deployment would downgrade the cookie for everyone; a forged
  // `https` on a plain-HTTP LAN only breaks login for whoever forged it.
  const proto = forwardedProto?.split(",")[0]?.trim().toLowerCase();
  if (proto === "https") return true;

  // No terminator in front. A private address with no TLS is plain HTTP by
  // construction; anything else defaults closed.
  return !isPrivateHost(host);
}

/**
 * Whether to serve this request at all.
 *
 * `"blocked"` means the instance is reachable from off this machine with no
 * passphrase configured — an open medical record. Refusing is the only
 * reasonable answer, and it is deliberately not a redirect to `/login`, since
 * there is no passphrase to enter.
 */
export function exposureVerdict(input: {
  host: string | null | undefined;
  authEnabled: boolean;
  allowInsecure: boolean;
}): "ok" | "blocked" {
  if (input.authEnabled || input.allowInsecure) return "ok";
  return isLoopbackHost(input.host) ? "ok" : "blocked";
}
