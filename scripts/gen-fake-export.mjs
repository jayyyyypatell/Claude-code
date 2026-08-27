/**
 * Generate a synthetic `export.xml` / `export.zip` at a realistic size.
 *
 *   node scripts/gen-fake-export.mjs --mb=500 --out=/tmp/export.xml
 *   node scripts/gen-fake-export.mjs --mb=500 --zip
 *
 * The point is the memory test. A real export from someone who has worn a
 * watch for a few years is several hundred megabytes of one XML document, and
 * that is the case the importer has to survive — so it needs to be reproducible
 * without asking anyone for their medical history.
 *
 * Written by streaming appends with backpressure, for the same reason the
 * importer reads that way: building the string first would need as much memory
 * as the file is large.
 */

import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const targetBytes = Number(args.mb ?? 200) * 1024 * 1024;
const out = args.out ?? "/tmp/export.xml";
const makeZip = Boolean(args.zip);

/** Weighted so the mix matches a real export: heart rate dominates by volume. */
const TYPES = [
  ["HKQuantityTypeIdentifierHeartRate", "count/min", 55, () => 55 + Math.random() * 60],
  ["HKQuantityTypeIdentifierStepCount", "count", 20, () => Math.floor(Math.random() * 250)],
  ["HKQuantityTypeIdentifierActiveEnergyBurned", "kcal", 12, () => Math.random() * 8],
  ["HKQuantityTypeIdentifierBasalEnergyBurned", "kcal", 6, () => Math.random() * 20],
  ["HKQuantityTypeIdentifierDistanceWalkingRunning", "km", 4, () => Math.random() * 0.2],
  ["HKQuantityTypeIdentifierHeartRateVariabilitySDNN", "ms", 1, () => 20 + Math.random() * 80],
  ["HKQuantityTypeIdentifierRestingHeartRate", "count/min", 1, () => 50 + Math.random() * 15],
  ["HKQuantityTypeIdentifierBodyMass", "kg", 1, () => 80 + Math.random() * 5],
];

const PICK = [];
for (const [type, unit, weight, gen] of TYPES) {
  for (let i = 0; i < weight; i++) PICK.push([type, unit, gen]);
}

const SOURCES = ["Apple Watch", "iPhone", "Health"];

function stamp(ms) {
  // Apple's format: space-separated, with an explicit offset. Deliberately not
  // ISO — matching the real thing is the whole point of this file.
  const d = new Date(ms - 7 * 3600_000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} -0700`
  );
}

async function write(stream, text) {
  if (!stream.write(text)) await once(stream, "drain");
}

async function main() {
  const stream = createWriteStream(out);
  let written = 0;
  const track = (s) => {
    written += Buffer.byteLength(s);
    return s;
  };

  await write(stream, track(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE HealthData [<!ELEMENT HealthData (ExportDate,Me,(Record|Workout)*)>]>\n` +
    `<HealthData locale="en_US">\n` +
    ` <ExportDate value="${stamp(Date.now())}"/>\n` +
    ` <Me HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexNotSet"/>\n`,
  ));

  // Walk backwards from now at one sample per ~30s of simulated time.
  let t = Date.now();
  const STEP_MS = 30_000;
  let sinceReport = 0;
  const chunk = [];

  while (written < targetBytes) {
    for (let i = 0; i < 2000; i++) {
      const [type, unit, gen] = PICK[(Math.random() * PICK.length) | 0];
      const start = t;
      const end = t + 1000;
      t -= STEP_MS;

      const source = SOURCES[(Math.random() * SOURCES.length) | 0];
      chunk.push(
        ` <Record type="${type}" sourceName="${source}" sourceVersion="10.2" ` +
          `unit="${unit}" creationDate="${stamp(end)}" startDate="${stamp(start)}" ` +
          `endDate="${stamp(end)}" value="${gen().toFixed(4)}"/>\n`,
      );
    }

    // A night of staged sleep and a workout every so often, so the parser's
    // accumulating paths get exercised rather than only <Record>.
    const nightEnd = t;
    let phaseStart = nightEnd - 7 * 3600_000;
    for (const phase of ["Core", "Deep", "REM", "Core", "Awake", "Core"]) {
      const dur = (30 + Math.random() * 60) * 60_000;
      chunk.push(
        ` <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Apple Watch" ` +
          `startDate="${stamp(phaseStart)}" endDate="${stamp(phaseStart + dur)}" ` +
          `value="HKCategoryValueSleepAnalysis${phase === "Awake" ? "Awake" : `Asleep${phase}`}"/>\n`,
      );
      phaseStart += dur;
    }

    chunk.push(
      ` <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="32.5" ` +
        `durationUnit="min" sourceName="Apple Watch" startDate="${stamp(t - 3600_000)}" ` +
        `endDate="${stamp(t - 1650_000)}">\n` +
        `  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="320" unit="kcal"/>\n` +
        `  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="5.2" unit="km"/>\n` +
        `  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="148" maximum="171" unit="count/min"/>\n` +
        ` </Workout>\n`,
    );

    const text = chunk.join("");
    chunk.length = 0;
    await write(stream, track(text));

    if (written - sinceReport > 50 * 1024 * 1024) {
      sinceReport = written;
      process.stdout.write(
        `\r  ${(written / 1024 / 1024).toFixed(0)} MB / ${(targetBytes / 1024 / 1024).toFixed(0)} MB`,
      );
    }
  }

  await write(stream, track("</HealthData>\n"));
  stream.end();
  await once(stream, "finish");

  process.stdout.write(`\r  wrote ${(written / 1024 / 1024).toFixed(1)} MB to ${out}\n`);

  if (makeZip) {
    const zipPath = out.replace(/\.xml$/, "") + ".zip";
    const dir = out.replace(/\/[^/]+$/, "");
    const staging = `${dir}/apple_health_export`;
    const { mkdir, rename, rm } = await import("node:fs/promises");
    await mkdir(staging, { recursive: true });
    await rename(out, `${staging}/export.xml`);
    await rm(zipPath, { force: true });
    // Store rather than deflate: this is a throwaway fixture and compressing
    // 500MB is slower than the import being measured.
    await promisify(execFile)("zip", ["-0", "-r", zipPath, "apple_health_export"], { cwd: dir });
    await rm(staging, { recursive: true, force: true });
    console.log(`  zipped to ${zipPath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
