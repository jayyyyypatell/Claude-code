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
