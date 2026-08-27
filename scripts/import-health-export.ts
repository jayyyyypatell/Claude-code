/**
 * Import an Apple Health `export.zip`.
 *
 *   npm run import -- ~/Downloads/export.zip
 *   npm run import -- ~/Downloads/export.zip --since=2024-01-01 --routes
 *
 * A full history takes a while and prints progress as it goes. It is safe to
 * run on a database live sync is already filling, and safe to run twice.
 */

import { importHealthExport } from "@/lib/import/run";
import { USER_TIMEZONE } from "@/lib/time/day";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function bar(fraction: number | null): string {
  if (fraction === null) return "";
  const width = 24;
  const filled = Math.round(fraction * width);
  return `[${"█".repeat(filled)}${"·".repeat(width - filled)}] ${(fraction * 100).toFixed(0)}%`;
}

function human(n: number): string {
  return n.toLocaleString("en-US");
}

async function main() {
  const path = process.argv[2];
  if (!path || path.startsWith("--")) {
    console.error("Usage: npm run import -- <path to export.zip> [--since=YYYY-MM-DD] [--routes]");
    process.exit(1);
  }

  const since = arg("since") ?? null;
  const storeRoutes = process.argv.includes("--routes");

  console.log(`Importing ${path}`);
  console.log(`  timezone : ${USER_TIMEZONE}`);
  if (since) console.log(`  since    : ${since}`);
  console.log(`  routes   : ${storeRoutes ? "stored" : "dropped"}`);
  console.log("");

  let lastLine = 0;
  const summary = await importHealthExport(path, {
    since,
    storeRoutes,
    onProgress: (p) => {
      // Rewrite one line rather than scrolling thousands.
      const now = Date.now();
      if (p.phase === "parsing" && now - lastLine < 250) return;
      lastLine = now;
      const line =
        p.phase === "parsing"
          ? `  ${bar(p.fraction)}  ${human(p.records)} records · ${human(p.points)} points`
          : `  ${p.phase}…`;
      process.stdout.write(`\r${line.padEnd(78)}`);
    },
  });

  process.stdout.write("\r".padEnd(80) + "\r");

  console.log("Done.\n");
  console.log(`  records read      ${human(summary.records)}`);
  console.log(`  points written    ${human(summary.points)}`);
  console.log(`  skipped           ${human(summary.skipped)}`);
  console.log(`  sleep sessions    ${human(summary.sleepSessions)}`);
  console.log(`  workouts          ${human(summary.workouts)}`);
  console.log(`  new metric types  ${human(summary.metricTypesCreated)}`);
  console.log(`  days rolled up    ${human(summary.rollupsRebuilt)}`);
  console.log(`  elapsed           ${(summary.elapsedMs / 1000).toFixed(1)}s`);
  if (summary.exportDate) console.log(`  exported          ${summary.exportDate}`);

  if (summary.unknownTypes.length) {
    console.log(`\n  ${summary.unknownTypes.length} type(s) not in the catalog — imported anyway:`);
    for (const t of summary.unknownTypes.slice(0, 15)) console.log(`    ${t}`);
  }

  if (summary.warnings.length) {
    console.log(`\n  ${summary.warnings.length} warning(s):`);
    for (const w of summary.warnings.slice(0, 15)) console.log(`    ${w}`);
  }

  console.log(
    "\nDelete the export when you're done with it — it's your complete medical\n" +
      "history in plaintext.",
  );
}

main().catch((err) => {
  console.error("\nImport failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
