import { redirect } from "next/navigation";

import { authEnabled, getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * The login screen.
 *
 * Deliberately says nothing about whether a passphrase was close, whether the
 * app has data, or who it belongs to — an unauthenticated visitor should learn
 * nothing beyond "there is a login here".
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;

  // With no APP_PASSWORD there is nothing to log into; sending someone to a
  // form that can never succeed would be worse than letting them through.
  if (!authEnabled()) redirect("/");

  const session = await getSession();
  if (session.authenticated) redirect("/");

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-2xl font-semibold" style={{ color: "var(--ink)" }}>
          Life
        </h1>
        <p className="text-sm" style={{ color: "var(--ink-muted)" }}>
          Enter your passphrase to continue.
        </p>
      </div>

      <form
        action="/api/auth/login"
        method="POST"
        className="flex flex-col gap-3"
      >
        <input type="hidden" name="next" value={next ?? "/"} />
        <input
          type="password"
          name="password"
          autoFocus
          required
          autoComplete="current-password"
          aria-label="Passphrase"
          className="rounded-xl border px-3.5 py-2.5 text-sm outline-none"
          style={{
            background: "var(--surface)",
            borderColor: "var(--hairline)",
            color: "var(--ink)",
          }}
        />

        {error && (
          <p className="text-sm" style={{ color: "var(--critical)" }}>
            That passphrase didn&rsquo;t work.
          </p>
        )}

        <button
          type="submit"
          className="rounded-xl px-4 py-2.5 text-sm font-medium text-white"
          style={{ background: "var(--series-1)" }}
        >
          Continue
        </button>
      </form>
    </main>
  );
}
