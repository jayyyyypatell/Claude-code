/**
 * POST every fixture at a running server and assert the ingest contract holds.
 *
 * This is the closest thing to a real phone push that can be run on a machine
 * with no iPhone attached, and it is the check to run after touching anything
 * in `src/lib/hae/`.
 *
 * Usage:
 *   npm run dev                       # in one terminal
 *   npm run replay                    # in another
 *   npm run replay -- --url https://your-tunnel.trycloudflare.com
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.split("=").slice(1).join("=");
  const idx = argv.indexOf(`--${name}`);
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : fallback;
};

const BASE = arg("url", "http://localhost:3000").replace(/\/$/, "");
const TOKEN = arg("token", process.env.INGEST_TOKEN ?? "");
const ENDPOINT = `${BASE}/api/ingest/hae`;
const FIXTURES = path.resolve(process.cwd(), "fixtures/hae");

if (!TOKEN) {
  console.error(
    "No ingest token. Set INGEST_TOKEN in .env.local (and load it), or pass --token=…",
  );
  process.exit(1);
}

interface IngestResponse {
  success?: boolean;
  duplicate?: boolean;
  batchId?: number;
  counts?: Record<string, number>;
  warnings?: string[];
  unknownMetrics?: string[];
  error?: string;
}

async function post(body: string): Promise<{ status: number; json: IngestResponse }> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ingest-token": TOKEN },
    body,
  });
  let json: IngestResponse = {};
  try {
    json = (await res.json()) as IngestResponse;
  } catch {
    /* non-JSON error page */
  }
  return { status: res.status, json };
}

async function totals(): Promise<{ points: number; nights: number; workouts: number }> {
  const res = await fetch(ENDPOINT, { headers: { "x-ingest-token": TOKEN } });
  const body = (await res.json()) as { totals?: Record<string, number> };
  return {
    points: Number(body.totals?.points ?? 0),
    nights: Number(body.totals?.nights ?? 0),
    workouts: Number(body.totals?.workouts ?? 0),
  };
}

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function main(): Promise<void> {
  console.log(`Replaying fixtures against ${ENDPOINT}\n`);

  /* --- auth must actually be enforced ------------------------------------ */
  console.log("Auth:");
  const noToken = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  check("rejects a request with no token", noToken.status === 401, `got ${noToken.status}`);

  const badToken = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ingest-token": "wrong" },
    body: "{}",
  });
  check("rejects a wrong token", badToken.status === 401, `got ${badToken.status}`);

  /* --- every fixture ingests --------------------------------------------- */
  console.log("\nFixtures:");
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort();

  for (const file of files) {
    const body = readFileSync(path.join(FIXTURES, file), "utf8");
    const { status, json } = await post(body);
    const c = json.counts ?? {};
    const summary = json.duplicate
      ? "duplicate (already ingested)"
      : `pts=${c.points ?? 0} sleep=${c.sleep ?? 0} workouts=${c.workouts ?? 0}` +
        (json.warnings?.length ? ` warnings=${json.warnings.length}` : "");
    check(file, status === 200 && json.success === true, summary);

    // A payload containing junk must still be a 200: HAE retries non-2xx, and
    // one unrecognised metric must never put the phone in a retry loop.
    //
    // Only assertable on a first ingest — a body seen within the last hour
    // short-circuits on its hash and returns no per-item detail, which is the
    // dedup working, not a failure.
    if (file.includes("malformed") && !json.duplicate) {
      check(
        "  …and malformed items produce warnings, not a failure",
        status === 200 && (json.warnings?.length ?? 0) > 0,
      );
    }
  }

  /* --- the property that matters ----------------------------------------- */
  console.log("\nIdempotency (replaying every fixture again must change nothing):");
  const before = await totals();
  for (const file of files) {
    await post(readFileSync(path.join(FIXTURES, file), "utf8"));
  }
  const after = await totals();

  check(
    "metric point count unchanged",
    before.points === after.points,
    `${before.points} → ${after.points}`,
  );
  check(
    "sleep night count unchanged",
    before.nights === after.nights,
    `${before.nights} → ${after.nights}`,
  );
  check(
    "workout count unchanged",
    before.workouts === after.workouts,
    `${before.workouts} → ${after.workouts}`,
  );

  console.log(
    failures === 0
      ? "\nAll checks passed."
      : `\n${failures} check(s) FAILED.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nReplay failed to run:", err instanceof Error ? err.message : err);
  console.error("Is the dev server running? `npm run dev`");
  process.exit(1);
});
