/**
 * Start the app so your phone can reach it over the WiFi.
 *
 *   npm run lan              production build, then serve on every interface
 *   npm run lan -- --dev     dev server instead (slower on a phone, hot reload)
 *   npm run lan -- --rebuild force a rebuild first
 *
 * This is the deliberate step that opens the app to the network, and it
 * refuses to run without a passphrase. `npm run dev` stays on localhost.
 *
 * Production build by default for two reasons: Next's dev server blocks
 * cross-origin requests to /_next/*, which breaks the page on a phone reaching
 * it by IP; and a dev build is painfully slow over WiFi on a phone. Hot reload
 * is worth nothing to someone who isn't editing the code.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import path from "node:path";

import { detectLanAddresses, localHostname } from "./lib/net.mjs";

const args = process.argv.slice(2);
const DEV = args.includes("--dev");
const FORCE_REBUILD = args.includes("--rebuild");
const OVERRIDE = args.includes("--i-know-this-is-open");
const PORT = process.env.PORT || "3000";

const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

function die(message) {
  console.error(`\n${RED}${message}${OFF}\n`);
  process.exit(1);
}

/** Read .env.local without depending on the app's own loader. */
function readEnvLocal() {
  if (!existsSync(".env.local")) return null;
  const out = {};
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * The gate.
 *
 * Enforced here rather than at request time because this is the only place
 * that knows the bind address — a `Host` header can be forged by anyone who
 * can already reach the socket, but refusing to open the socket cannot be.
 */
function assertSafeToExpose(env) {
  if (!env) {
    die("No .env.local found.\n\nRun this first:   npm run setup");
  }

  const password = env.APP_PASSWORD ?? "";
  const secret = env.SESSION_SECRET ?? "";

  if (OVERRIDE && process.env.ALLOW_INSECURE_LAN === "1") {
    console.error(
      `\n${RED}${BOLD}  Serving an unprotected health history to your network.${OFF}\n` +
        `${RED}  Anyone on this WiFi can read every night's sleep, every workout,\n` +
        `  and your journal. No passphrase is set.${OFF}\n`,
    );
    return;
  }

  if (!password) {
    die(
      `${BOLD}Refusing to start.${OFF}${RED}\n\n` +
        "This would serve your complete health history to every device on your\n" +
        "network — guests included — with no passphrase.\n\n" +
        `Set one:   ${BOLD}npm run setup${OFF}${RED}\n\n` +
        `Or stay on this machine only:   ${BOLD}npm run dev${OFF}`,
    );
  }

  if (secret.length < 32) {
    die(
      `${BOLD}SESSION_SECRET is too short${OFF}${RED} (${secret.length} chars, needs 32+).\n\n` +
        "Login would fail at the moment you tried it, which is a confusing\n" +
        "place to find out.\n\n" +
        `Fix it:   ${BOLD}npm run setup -- --merge${OFF}`,
    );
  }

  if (!env.INGEST_TOKEN) {
    console.warn(
      `${DIM}  Note: INGEST_TOKEN is not set, so the phone can't push data yet.${OFF}`,
    );
  }
}

/** Newest mtime under a directory, for deciding whether the build is stale. */
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  try {
    walk(dir);
  } catch {
    return Infinity;
  }
  return newest;
}

function buildIsStale() {
  const id = ".next/BUILD_ID";
  if (!existsSync(id)) return true;
  return newestMtime("src") > statSync(id).mtimeMs;
}

const env = readEnvLocal();
assertSafeToExpose(env);

const hosts = [localHostname(), ...detectLanAddresses()].filter(Boolean);

if (!DEV && (FORCE_REBUILD || buildIsStale())) {
  console.log("\nBuilding (about a minute, only needed after a code change)…\n");
  const built = spawnSync("npx", ["next", "build"], { stdio: "inherit" });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

console.log(`\n${BOLD}Life is starting on your network.${OFF}\n`);
if (hosts.length === 0) {
  console.log("  No network address found — are you connected to WiFi?\n");
} else {
  console.log("  On this Mac:      http://localhost:" + PORT);
  console.log(`  On your iPhone:   http://${hosts[0]}:${PORT}`);
  if (hosts.length > 1) {
    console.log(`${DIM}  If that one doesn't work, try:${OFF}`);
    for (const h of hosts.slice(1)) console.log(`                    http://${h}:${PORT}`);
  }
  console.log("");
  console.log(`  Health Auto Export URL:`);
  console.log(`  ${BOLD}http://${hosts[0]}:${PORT}/api/ingest/hae${OFF}\n`);
}
console.log(
  `${DIM}  macOS may ask whether "node" can accept incoming connections.\n` +
    `  Click Allow, or your phone will not be able to reach this.${OFF}\n`,
);

const childArgs = DEV
  ? ["next", "dev", "-H", "0.0.0.0", "-p", PORT]
  : ["next", "start", "-H", "0.0.0.0", "-p", PORT];

// The dev server rejects cross-origin /_next/* requests unless the origin is
// allow-listed, which is exactly what a phone reaching this by IP looks like.
const childEnv = { ...process.env };
if (DEV) {
  childEnv.NEXT_ALLOWED_DEV_ORIGINS = hosts.join(",");
}

const child = spawn("npx", childArgs, { stdio: "inherit", env: childEnv });
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
child.on("exit", (code) => process.exit(code ?? 0));
