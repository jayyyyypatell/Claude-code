export const metadata = { title: "Offline" };

/**
 * Shown when a navigation fails and nothing is cached.
 *
 * Says what is actually true — the phone is still collecting, nothing is lost
 * — rather than a generic error. Health data accumulating on the device is
 * exactly the reassurance someone needs at this moment.
 */
export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-3 px-6 text-center">
      <h1 className="text-xl font-semibold" style={{ color: "var(--ink)" }}>
        You&rsquo;re offline
      </h1>
      <p className="text-sm" style={{ color: "var(--ink-2)" }}>
        Pages you&rsquo;ve already opened will still load. Your phone keeps
        recording either way and will sync whatever it collected once you have
        a connection again.
      </p>
    </main>
  );
}
