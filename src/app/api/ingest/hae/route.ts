import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

import { client } from "@/db/index";
import { normalizeHaePayload } from "@/lib/hae/normalize";
import { persistNormalized } from "@/lib/hae/persist";
import { USER_TIMEZONE } from "@/lib/time/day";

/**
 * The endpoint Health Auto Export pushes to, several times a day, from your
 * phone. This is the only route deliberately exposed to the public internet.
 *
 * Response policy: **anything that isn't auth, oversize, or unparseable JSON
 * returns 200.** HAE retries non-2xx responses, so a single unrecognised
 * metric answering 500 would put the phone into a retry loop and, worse, could
 * stall the queue behind it. Per-item problems are reported in the response
 * body and the ingest log instead.
 */

// Native SQLite bindings and the filesystem both rule out the Edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const gzipAsync = promisify(gzip);

/** 32 MB. A routine push is well under 1 MB; this is a sanity bound. */
const MAX_BYTES = Number(process.env.MAX_INGEST_BYTES ?? 32 * 1024 * 1024);

const RAW_DIR = path.resolve(process.cwd(), "data", "raw");

/**
 * Constant-time bearer check.
 *
 * `timingSafeEqual` throws when the buffers differ in length, which would both
 * crash the handler and leak length through the error path — so length is
 * compared first, and only then the contents.
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  // HAE lets you set arbitrary headers; this form is easier to configure on
  // the phone than an Authorization header.
  return req.headers.get("x-ingest-token");
}

/**
 * Archive the exact bytes received, before parsing.
 *
 * A parser bug must never lose health data — unlike a web request, you cannot
 * ask the past for its step count again. With the raw payloads on disk, a
 * normalizer fix can be replayed over the whole history.
 */
async function archiveRaw(body: string, id: number): Promise<string | null> {
  if (process.env.KEEP_RAW_PAYLOADS === "0") return null;
  try {
    await mkdir(RAW_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rel = path.join("data", "raw", `${stamp}-${id}.json.gz`);
    await writeFile(path.resolve(process.cwd(), rel), await gzipAsync(body));
    return rel;
  } catch {
    // Archiving is a safety net, not a precondition. Losing the archive is
    // much better than rejecting the push that carried the data.
    return null;
  }
}

export async function POST(req: Request): Promise<Response> {
  /* ----------------------------------------------------------------- auth -- */
  const expected = process.env.INGEST_TOKEN;
  if (!expected) {
    return Response.json(
      {
        success: false,
        error:
          "INGEST_TOKEN is not configured on the server. Set it in .env.local — see .env.example.",
      },
      { status: 503 },
    );
  }

  const provided = extractToken(req);
  if (!provided || !tokenMatches(provided, expected)) {
    return Response.json(
      { success: false, error: "Invalid or missing ingest token." },
      { status: 401 },
    );
  }

  /* ----------------------------------------------------------------- size -- */
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) {
    return Response.json(
      { success: false, error: `Payload exceeds ${MAX_BYTES} bytes.` },
      { status: 413 },
    );
  }

  const body = await req.text();
  if (body.length > MAX_BYTES) {
    return Response.json(
      { success: false, error: `Payload exceeds ${MAX_BYTES} bytes.` },
      { status: 413 },
    );
  }

  /* -------------------------------------------------------------- logging -- */
  const bodyHash = createHash("sha256").update(body).digest("hex");

  const logRow = await client.execute({
    sql: `INSERT INTO ingest_log (source, status, bytes, body_hash)
          VALUES ('hae','running',?,?) RETURNING id`,
    args: [body.length, bodyHash],
  });
  const logId = Number(logRow.rows[0].id);

  const rawPath = await archiveRaw(body, logId);
  if (rawPath) {
    await client.execute({
      sql: "UPDATE ingest_log SET raw_path = ? WHERE id = ?",
      args: [rawPath, logId],
    });
  }

  const fail = async (message: string, status: number): Promise<Response> => {
    await client.execute({
      sql: `UPDATE ingest_log
            SET status='error', error=?, finished_at=unixepoch()*1000 WHERE id=?`,
      args: [message, logId],
    });
    return Response.json({ success: false, error: message }, { status });
  };

  /* ---------------------------------------------------------------- parse -- */
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (err) {
    return fail(
      `Body is not valid JSON: ${err instanceof Error ? err.message : "unknown"}`,
      400,
    );
  }

  /* -------------------------------------------------------- dedup by hash -- */
  // The upserts already make a replay harmless; this just avoids redoing the
  // rollup work when HAE retries a push that actually succeeded.
  const recent = await client.execute({
    sql: `SELECT id FROM ingest_log
          WHERE body_hash = ?
            AND id != ?
            AND status IN ('ok','partial')
            AND received_at > (unixepoch() - 3600) * 1000
          LIMIT 1`,
    args: [bodyHash, logId],
  });
  if (recent.rows.length) {
    await client.execute({
      sql: `UPDATE ingest_log SET status='ok', progress=100,
            finished_at=unixepoch()*1000, error='duplicate of an earlier push'
            WHERE id=?`,
      args: [logId],
    });
    return Response.json({ success: true, ok: true, duplicate: true, batchId: logId });
  }

  /* ------------------------------------------------------------ normalize -- */
  try {
    const normalized = normalizeHaePayload(payload, {
      timeZone: process.env.USER_TIMEZONE ?? USER_TIMEZONE,
      storeRoutes: process.env.HAE_STORE_ROUTES === "1",
    });

    const counts = await persistNormalized(normalized);

    await client.execute({
      sql: `UPDATE ingest_log SET
              status = ?, finished_at = unixepoch()*1000, progress = 100,
              metrics_seen = ?, points_upserted = ?, sleep_upserted = ?,
              workouts_upserted = ?, warnings = ?
            WHERE id = ?`,
      args: [
        normalized.warnings.length ? "partial" : "ok",
        counts.metricTypesCreated,
        counts.pointsUpserted,
        counts.sleepUpserted,
        counts.workoutsUpserted,
        normalized.warnings.length ? JSON.stringify(normalized.warnings) : null,
        logId,
      ],
    });

    return Response.json({
      success: true,
      ok: true,
      batchId: logId,
      counts: {
        points: counts.pointsUpserted,
        sleep: counts.sleepUpserted,
        workouts: counts.workoutsUpserted,
        newMetricTypes: counts.metricTypesCreated,
        rollupDays: counts.rollupsRebuilt,
      },
      unknownMetrics: normalized.unknownMetrics,
      warnings: normalized.warnings,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A genuine server-side failure — the raw payload is on disk, so this can
    // be replayed once fixed. 500 is correct here: we want HAE to retry.
    return fail(`Ingest failed: ${message}`, 500);
  }
}

/**
 * A target for Health Auto Export's "test connection" button, and a general
 * health check. Requires the same token so it can't be used to probe whether
 * an instance exists.
 */
export async function GET(req: Request): Promise<Response> {
  const expected = process.env.INGEST_TOKEN;
  const provided = extractToken(req);
  if (!expected || !provided || !tokenMatches(provided, expected)) {
    return Response.json({ ok: false }, { status: 401 });
  }

  const last = await client.execute(
    `SELECT received_at, status, points_upserted FROM ingest_log
     WHERE source='hae' ORDER BY received_at DESC LIMIT 1`,
  );
  const totals = await client.execute(
    `SELECT (SELECT COUNT(*) FROM metric_points)  AS points,
            (SELECT COUNT(*) FROM metric_types)   AS metrics,
            (SELECT COUNT(*) FROM sleep_sessions) AS nights,
            (SELECT COUNT(*) FROM workouts)       AS workouts`,
  );

  return Response.json({
    ok: true,
    lastIngestAt: last.rows[0]?.received_at ?? null,
    lastStatus: last.rows[0]?.status ?? null,
    totals: totals.rows[0],
  });
}
