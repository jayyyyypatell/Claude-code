import { mkdirSync } from "node:fs";
import path from "node:path";

import type { Config } from "drizzle-kit";

const url = process.env.DATABASE_URL ?? "file:./data/life.db";

// drizzle-kit evaluates this config in its own process, so it can't rely on
// the app having created the directory first.
if (url.startsWith("file:")) {
  mkdirSync(path.dirname(url.slice("file:".length)), { recursive: true });
}

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "turso",
  dbCredentials: {
    url,
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
} satisfies Config;
