/**
 * First-run setup. One command, no config file to edit by hand.
 *
 *   npm run setup
 *   npm run setup -- --merge     fill in keys missing from an existing .env.local
 *
 * Deliberately does the work rather than printing instructions. The previous
 * quickstart asked someone to generate secrets with a `node -e` incantation,
 * know their own IANA timezone string, and create a directory the README
 * didn't mention — three chances to get it wrong before the app had ever run.
 */
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";

import { WORDS } from "./setup-wordlist.mjs";
import { detectLanAddresses, localHostname } from "./lib/net.mjs";

const args = process.argv.slice(2);
const MERGE = args.includes("--merge");
const PASSWORD_ARG = args.find((a) => a.startsWith("--password="))?.slice(11);

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const OFF = "\x1b[0m";

const say = (s = "") => console.log(s);
const die = (s) => { console.error(`\n${RED}${s}${OFF}\n`); process.exit(1); };

/* ------------------------------------------------------------ node version */

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 9)) {
  die(
    `Life needs Node 20.9 or newer. You have ${process.versions.node}.\n\n` +
      "Install the current LTS from https://nodejs.org and run this again.",
  );
}

/* ------------------------------------------------------------ dependencies */

if (!existsSync("node_modules/drizzle-kit")) {
  say("Installing dependencies (this takes a minute)…\n");
  const r = spawnSync("npm", ["install"], { stdio: "inherit" });
  if (r.status !== 0) die("npm install failed. Scroll up for the reason.");
  say("");
}

/* --------------------------------------------------------------- timezone */

/**
 * Read from the machine rather than asked for.
 *
 * Every "per day" number in the app is bucketed against this, so a wrong value
 * silently shifts steps and sleep onto neighbouring days — a failure that
 * produces plausible numbers rather than an error. A typed IANA name is a
 * guess; the operating system already knows.
 */
function detectTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz) return null;
    new Intl.DateTimeFormat("en-US", { timeZone: tz });  // throws if bogus
    return tz;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- secrets */

const secret = () => randomBytes(32).toString("hex");
const passphrase = (n = 4) =>
  Array.from({ length: n }, () => WORDS[randomInt(WORDS.length)]).join("-");

/* ------------------------------------------------------------ env parsing */

function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

async function askPassphrase(suggested) {
  if (PASSWORD_ARG) return PASSWORD_ARG;
  // Non-interactive (CI, a piped run): take the generated one rather than hang.
  if (!process.stdin.isTTY) return suggested;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  say(`\n  ${BOLD}Choose a passphrase.${OFF}`);
  say(`  ${DIM}You'll type this to open the app, including on your phone.${OFF}`);
  say(`  ${DIM}Press Enter to accept the suggestion.${OFF}\n`);
  // Echoed on purpose: this runs on your own machine, and it is written to
  // .env.local in plaintext two lines later — hiding it at the prompt would be
  // theatre, and a terminal that shows nothing while you type reads as broken.
  const answer = (await rl.question(`  [${suggested}] > `)).trim();
  rl.close();
  return answer || suggested;
}

/* -------------------------------------------------------------------- main */

const timeZone = detectTimeZone();
if (!timeZone) {
  say(`${RED}  Could not detect your timezone; using UTC.${OFF}`);
  say(`${DIM}  Set USER_TIMEZONE in .env.local if your days look shifted.${OFF}\n`);
} else if (timeZone === "UTC" && process.platform === "darwin") {
  say(`${RED}  Your Mac reports UTC, which is usually wrong.${OFF}`);
  say(`${DIM}  Check System Settings → General → Date & Time, then edit`);
  say(`  USER_TIMEZONE in .env.local.${OFF}\n`);
}

const REQUIRED = ["DATABASE_URL", "USER_TIMEZONE", "INGEST_TOKEN", "SESSION_SECRET", "APP_PASSWORD"];
const existing = existsSync(".env.local")
  ? parseEnv(readFileSync(".env.local", "utf8"))
  : null;

let password;

if (!existing) {
  password = await askPassphrase(passphrase());
  const body = `# Written by \`npm run setup\`. Safe to edit; never committed.

DATABASE_URL="file:./data/life.db"

# Detected from this machine. Every daily figure is bucketed against it.
USER_TIMEZONE="${timeZone ?? "UTC"}"

# The bearer token Health Auto Export sends. Also shown on the Settings page.
INGEST_TOKEN="${secret()}"

# Opens the app. Required before anything but localhost can reach it.
APP_PASSWORD="${password}"
SESSION_SECRET="${secret()}"
CRON_SECRET="${secret()}"

# The AI coach. Get a key at https://console.anthropic.com, or set
# AI_PROVIDER="mock" to try the interface without one.
ANTHROPIC_API_KEY=""

# Set to 1 to keep workout GPS routes (large, and nothing renders them yet).
HAE_STORE_ROUTES=
`;
  writeFileSync(".env.local", body, { mode: 0o600 });
  say(`${GREEN}  Wrote .env.local${OFF}`);
} else {
  password = existing.APP_PASSWORD || "";
  const missing = REQUIRED.filter((k) => !existing[k]);

  if (missing.length === 0) {
    say(`${DIM}  .env.local already looks complete — left untouched.${OFF}`);
  } else if (MERGE) {
    // Appending, never rewriting: this file holds the only copy of a passphrase
    // someone may have written down.
    const lines = [`\n# --- added by npm run setup on ${new Date().toISOString().slice(0, 10)} ---`];
    for (const k of missing) {
      if (k === "DATABASE_URL") lines.push(`DATABASE_URL="file:./data/life.db"`);
      else if (k === "USER_TIMEZONE") lines.push(`USER_TIMEZONE="${timeZone ?? "UTC"}"`);
      else if (k === "APP_PASSWORD") {
        password = await askPassphrase(passphrase());
        lines.push(`APP_PASSWORD="${password}"`);
      } else lines.push(`${k}="${secret()}"`);
    }
    appendFileSync(".env.local", lines.join("\n") + "\n");
    say(`${GREEN}  Added to .env.local: ${missing.join(", ")}${OFF}`);
  } else {
    say(`${RED}  .env.local exists but is missing: ${missing.join(", ")}${OFF}`);
    say(`\n  Nothing was changed. To fill in just the missing keys:\n`);
    say(`      ${BOLD}npm run setup -- --merge${OFF}\n`);
    process.exit(0);
  }

  // A short secret throws at the moment of login, which is a long way from
  // the cause.
  if (existing.SESSION_SECRET && existing.SESSION_SECRET.length < 32) {
    say(`${RED}  SESSION_SECRET is only ${existing.SESSION_SECRET.length} characters; it needs 32+.${OFF}`);
    say(`${DIM}  Replace it with: ${secret()}${OFF}`);
  }
}

/* ------------------------------------------------------- database + schema */

mkdirSync("data", { recursive: true });

say("\n  Creating the database…");
const push = spawnSync(
  "node",
  ["--env-file=.env.local", "node_modules/drizzle-kit/bin.cjs", "push"],
  { stdio: "inherit" },
);
if (push.status !== 0) die("Could not create the database. Scroll up for the reason.");

/* ------------------------------------------------------------- next steps */

const hosts = [localHostname(), ...detectLanAddresses()].filter(Boolean);

say(`\n${GREEN}${BOLD}  Done.${OFF}\n`);
say(`  Start it:          ${BOLD}npm run dev${OFF}   ${DIM}(this Mac only)${OFF}`);
say(`  Open:              http://localhost:3000`);
if (password) say(`  Your passphrase:   ${BOLD}${password}${OFF}  ${DIM}← write this down${OFF}`);

say(`\n  ${BOLD}Import your Apple Health history${OFF}`);
say(`  ${DIM}iPhone → Health → your photo (top right) → Export All Health Data.`);
say(`  AirDrop the zip to this Mac, then:${OFF}`);
say(`      npm run import -- ~/Downloads/export.zip`);

say(`\n  ${BOLD}Sync from your iPhone over WiFi${OFF}`);
say(`      npm run lan`);
if (hosts.length) {
  say(`\n  ${DIM}Health Auto Export URL:${OFF}`);
  say(`      http://${hosts[0]}:3000/api/ingest/hae`);
  say(`  ${DIM}Header  x-ingest-token  — the value is on the Settings page,`);
  say(`  with a copy button, because it is 64 characters of hex.${OFF}`);
}
say("");
