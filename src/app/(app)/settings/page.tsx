import { CopyField } from "@/components/CopyField";
import { getSyncStatus, listMetrics } from "@/db/queries/metrics";
import { coachIsConfigured, isMockMode } from "@/lib/ai/client";
import { authEnabled } from "@/lib/auth";
import { relativeTime } from "@/lib/format";
import { USER_TIMEZONE } from "@/lib/time/day";

export const dynamic = "force-dynamic";

/**
 * Settings, and the Health Auto Export walkthrough.
 *
 * The setup steps live in the app rather than only in the README, because
 * that's where you'll be standing with your phone in your hand. The ingest
 * token has a copy button for the same reason — typing 64 hex characters into
 * an iPhone is genuinely unpleasant.
 */
export default async function SettingsPage() {
  const [sync, metrics] = await Promise.all([getSyncStatus(), listMetrics()]);

  const token = process.env.INGEST_TOKEN ?? "";
  const configured = {
    ingest: Boolean(token),
    coach: coachIsConfigured(),
    auth: authEnabled(),
    cron: Boolean(process.env.CRON_SECRET),
  };

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        Settings
      </h1>

      {/* Security first — this is the one that matters before deploying. */}
      {!configured.auth && (
        <section
          className="rounded-xl border p-4"
          style={{ borderColor: "var(--critical)", background: "var(--surface)" }}
        >
          <h2 className="mb-1 text-sm font-medium" style={{ color: "var(--ink)" }}>
            No login is set
          </h2>
          <p className="text-sm" style={{ color: "var(--ink-2)" }}>
            Anyone who can reach this address can read your complete health
            history. That&rsquo;s fine on your own machine and not fine anywhere
            else. Set <code>APP_PASSWORD</code> and{" "}
            <code>SESSION_SECRET</code> in <code>.env.local</code> before
            putting this on the internet or behind a tunnel.
          </p>
        </section>
      )}

      <Section title="Sync">
        <Row label="Last push" value={relativeTime(sync.lastIngestAt)} />
        <Row label="Status" value={sync.lastStatus ?? "never"} />
        <Row label="Source" value={sync.lastSource ?? "—"} />
        <Row label="Data points" value={sync.totalPoints.toLocaleString()} />
        <Row label="Metrics tracked" value={String(metrics.length)} />
      </Section>

      <section
        className="flex flex-col gap-3 rounded-xl border p-4"
        style={{ background: "var(--surface)", borderColor: "var(--hairline)" }}
      >
        <h2 className="text-base font-medium" style={{ color: "var(--ink)" }}>
          Connect your iPhone
        </h2>
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          Health Auto Export pushes your Apple Health data here automatically,
          several times a day. Install it from the App Store, then:
        </p>

        <ol
          className="ml-4 flex list-decimal flex-col gap-2 text-sm"
          style={{ color: "var(--ink-2)" }}
        >
          <li>Open Health Auto Export → Automations → add a REST API automation.</li>
          <li>
            Set the URL to <code>&lt;this site&gt;/api/ingest/hae</code>, method{" "}
            <strong>POST</strong>, format <strong>JSON</strong>.
          </li>
          <li>
            Add a header named <code>x-ingest-token</code> with the token below.
          </li>
          <li>Select the metrics you want — or all of them.</li>
          <li>
            Set aggregation to <strong>hourly</strong> and an interval of 1–4
            hours.
          </li>
        </ol>

        {configured.ingest ? (
          <CopyField label="x-ingest-token" value={token} secret />
        ) : (
          <p className="text-sm" style={{ color: "var(--critical)" }}>
            No <code>INGEST_TOKEN</code> set — the endpoint will reject
            everything until there is one. Generate it with{" "}
            <code>
              node -e &quot;console.log(require(&apos;crypto&apos;).randomBytes(32).toString(&apos;hex&apos;))&quot;
            </code>
          </p>
        )}

        <p className="text-xs" style={{ color: "var(--ink-muted)" }}>
          Your phone can&rsquo;t reach <code>localhost</code>. For testing, run{" "}
          <code>npx cloudflared tunnel --url http://localhost:3000</code> to get
          a public HTTPS address. For daily use, deploy it — and don&rsquo;t
          leave health data behind a random public tunnel URL long-term.
        </p>
      </section>

      <section
        className="flex flex-col gap-3 rounded-xl border p-4"
        style={{ borderColor: "var(--hairline)", background: "var(--surface)" }}
      >
        <h2 className="text-base font-medium" style={{ color: "var(--ink)" }}>
          Import your history
        </h2>
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          Live sync only carries data from the day you connected your phone
          onward. To bring in everything before that, export from Health.app
          once and import the file.
        </p>

        <ol
          className="ml-4 flex list-decimal flex-col gap-2 text-sm"
          style={{ color: "var(--ink-2)" }}
        >
          <li>
            Health.app &rarr; your photo (top right) &rarr;{" "}
            <strong>Export All Health Data</strong>. It takes a few minutes and
            produces <code>export.zip</code>.
          </li>
          <li>Get the file onto the machine running this app.</li>
          <li>
            Run{" "}
            <code
              className="rounded px-1.5 py-0.5 text-xs"
              style={{ background: "var(--surface-2)" }}
            >
              npm run import -- /path/to/export.zip
            </code>
          </li>
        </ol>

        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          Safe to run on top of live sync, and safe to run twice — everything
          upserts. A decade of history is normal and takes a minute or two.
        </p>

        <p className="text-xs" style={{ color: "var(--ink-muted)" }}>
          Add <code>--since=2024-01-01</code> to import only recent history, or{" "}
          <code>--routes</code> to keep workout GPS traces (off by default).
        </p>

        <p className="text-sm" style={{ color: "var(--critical)" }}>
          Delete <code>export.zip</code> when you&rsquo;re done — it&rsquo;s
          your complete medical history in plaintext.
        </p>
      </section>

      <Section title="Configuration">
        <Row label="Timezone" value={USER_TIMEZONE} hint="USER_TIMEZONE" />
        <Row
          label="Ingest token"
          value={configured.ingest ? "set" : "not set"}
          hint="INGEST_TOKEN"
          warn={!configured.ingest}
        />
        <Row
          label="AI coach"
          value={
            isMockMode() ? "mock mode" : configured.coach ? "set" : "not set"
          }
          hint="ANTHROPIC_API_KEY"
          warn={!configured.coach}
        />
        <Row
          label="Login"
          value={configured.auth ? "enabled" : "disabled"}
          hint="APP_PASSWORD"
          warn={!configured.auth}
        />
        <Row
          label="Weekly report job"
          value={configured.cron ? "set" : "not set"}
          hint="CRON_SECRET"
        />
        <Row
          label="Push aggregation"
          value={process.env.HAE_AGGREGATION?.trim() || "auto-detect"}
          hint="HAE_AGGREGATION"
        />
      </Section>

      <Section title="Privacy">
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          Workout GPS routes are <strong>not stored</strong> unless{" "}
          <code>HAE_STORE_ROUTES=1</code>. Journal entries marked private are
          excluded from everything the AI coach can read — enforced in the
          database query, not by asking the model. Raw pushes are archived to{" "}
          <code>data/raw/</code> before parsing so a bug can be replayed rather
          than losing data; set <code>KEEP_RAW_PAYLOADS=0</code> to turn that
          off.
        </p>
      </Section>

      {configured.auth && (
        <form action="/api/auth/logout" method="POST">
          <button
            type="submit"
            className="rounded-lg border px-4 py-2 text-sm"
            style={{
              borderColor: "var(--hairline)",
              color: "var(--ink-2)",
              background: "var(--surface)",
            }}
          >
            Sign out
          </button>
        </form>
      )}
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2
        className="text-xs font-medium uppercase tracking-wide"
        style={{ color: "var(--ink-muted)" }}
      >
        {title}
      </h2>
      <div
        className="flex flex-col divide-y rounded-xl border"
        style={{ background: "var(--surface)", borderColor: "var(--hairline)" }}
      >
        {children}
      </div>
    </section>
  );
}

function Row({
  label,
  value,
  hint,
  warn,
}: {
  label: string;
  value: string;
  hint?: string;
  warn?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 p-3 text-sm"
      style={{ borderColor: "var(--hairline)" }}
    >
      <span style={{ color: "var(--ink)" }}>
        {label}
        {hint && (
          <code className="ml-2 text-xs" style={{ color: "var(--ink-muted)" }}>
            {hint}
          </code>
        )}
      </span>
      <span style={{ color: warn ? "var(--critical)" : "var(--ink-2)" }}>
        {value}
      </span>
    </div>
  );
}
