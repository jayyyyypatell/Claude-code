import { readdirSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient, type Client } from "@libsql/client";

/**
 * Spin up a throwaway database with the real schema applied.
 *
 * Tests run against the *generated migrations*, not a hand-maintained copy of
 * the DDL. That way a schema change that breaks a constraint shows up as a
 * failing test rather than passing against a stale fixture schema.
 */
export interface TestDb {
  client: Client;
  dir: string;
  close(): void;
}

const MIGRATIONS_DIR = path.resolve(process.cwd(), "drizzle");

export async function createTestDb(): Promise<TestDb> {
  const dir = mkdtempSync(path.join(tmpdir(), "lifetracker-test-"));
  const client = createClient({ url: `file:${path.join(dir, "test.db")}` });

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    throw new Error(
      `No migrations found in ${MIGRATIONS_DIR}. Run \`npx drizzle-kit generate\` first.`,
    );
  }

  for (const file of files) {
    const sqlText = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    // drizzle-kit separates statements with this marker rather than bare
    // semicolons, which would split string literals containing one.
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) await client.execute(trimmed);
    }
  }

  return {
    client,
    dir,
    close() {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
