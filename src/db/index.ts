import { mkdirSync } from "node:fs";
import path from "node:path";

import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import * as schema from "./schema";

/**
 * libSQL is used for both ends of the deployment story:
 *
 *   local dev   DATABASE_URL=file:./data/life.db   (a plain SQLite file)
 *   deployed    DATABASE_URL=libsql://…            (hosted Turso, over HTTP)
 *
 * Same driver, same queries, no native module — which is what makes this
 * deployable to a serverless host without swapping the data layer.
 */
const url = process.env.DATABASE_URL ?? "file:./data/life.db";
const authToken = process.env.DATABASE_AUTH_TOKEN;

/**
 * `data/` is gitignored, so a fresh clone doesn't have it, and libSQL will not
 * create a missing parent directory — it just fails to open the database. That
 * turned the first command of the README into an error for anyone who had
 * never run the app before.
 */
if (url.startsWith("file:")) {
  mkdirSync(path.dirname(url.slice("file:".length)), { recursive: true });
}

/**
 * Next.js re-evaluates modules on every hot reload in dev. Without a global
 * pin, each reload opens another connection and they accumulate until the
 * process runs out of file handles.
 */
const globalForDb = globalThis as unknown as {
  __lifeTrackerClient?: Client;
};

const client =
  globalForDb.__lifeTrackerClient ?? createClient({ url, authToken });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__lifeTrackerClient = client;
}

export const db = drizzle(client, { schema });
export { client, schema };
export type Db = typeof db;
