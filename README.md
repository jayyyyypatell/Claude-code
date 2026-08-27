# Life Tracker

A personal life tracker that pulls everything out of Apple Health automatically,
adds habits and a daily journal, and puts an AI coach on top that can actually
read your data.

It runs on your own Mac. Your iPhone pushes health data to it over your home
WiFi several times a day on its own — no manual exporting, and nothing leaves
your network. You can install it to your phone's home screen like an app.

> **This repository is public.** Your health data, database, and API keys are
> excluded by `.gitignore` and must stay that way. See [Privacy](#privacy).

---

## How data gets in

```
iPhone ──► Health Auto Export ──POST──► /api/ingest/hae ──► normalise ──► SQLite
             (automatic, several times a day, 150+ metrics)

Health.app export.zip ──► streaming XML import ──────────► same tables
             (one-time backfill of your full history)
```

Both paths converge on the same upsert, so backfilling your history after live
sync has been running is safe and repeatable.

---

## Status

| Milestone | State |
|---|---|
| M0 — schema, rollups, seed data | ✅ done |
| M1 — Health Auto Export ingest | ✅ done |
| M2 — Today / Trends / Sleep pages | ✅ done |
| M3 — habits & journal | ✅ done |
| M4 — AI coach | ✅ done |
| M5 — weekly insights | ✅ done |
| M6 — PWA, login, settings | ✅ done |
| M7 — export.zip backfill | ✅ done |

---

## Run it on your Mac

Everything runs on your own laptop. Nothing goes to anyone else's server.

**If you have never used Terminal:** press ⌘-Space, type `Terminal`, press Enter.
A window opens where you type commands. Paste these one at a time.

```bash
git clone https://github.com/jayyyyypatell/Claude-code.git
cd Claude-code
npm run setup
npm run dev
```

Then open **http://localhost:3000**.

That's it. `npm run setup` installs everything, detects your timezone, generates
your passphrase and secrets, and creates the database. It prints the passphrase
at the end — **write it down**, it's the only copy.

Running it again is safe: it never overwrites an existing `.env.local`.

> Needs Node 20.9 or newer. If `npm` isn't found, install the LTS build from
> [nodejs.org](https://nodejs.org) and start again.

### If something goes wrong

| What you see | What it means |
|---|---|
| `command not found: npm` | Node isn't installed — see the note above. |
| The page asks for a passphrase | Normal. It's the one `npm run setup` printed. |
| Times or daily totals look shifted | `USER_TIMEZONE` in `.env.local` is wrong. Fix it, then restart the server — it's read at startup. |

---

## Connect your iPhone

Your phone talks to your Mac **directly over your home WiFi**. Both need to be
on the same network. Nothing is exposed to the internet.

`npm run dev` deliberately only listens on the Mac itself. To let your phone
reach it:

```bash
npm run lan
```

It prints the address to use, and refuses to start without a passphrase set —
your WiFi is not a security boundary, and this holds a complete medical history.

> The first time, macOS may ask whether **node** can accept incoming
> connections. Click **Allow**. If you click Deny, your phone gets a timeout
> with no error shown on the Mac; undo it in System Settings → Network →
> Firewall → Options.

Then, in **Health Auto Export** (App Store, free):

1. Automations → add a **REST API** automation
2. URL: the one `npm run lan` printed, ending `/api/ingest/hae`
3. Method **POST**, format **JSON**
4. Add a header `x-ingest-token` — the value is on the app's Settings page with
   a copy button, because it's 64 characters of hex
5. Select the metrics you want, or all of them
6. Aggregation **hourly**, interval 1–4 hours

Tap its test button, then open Settings in the app — "Last push" should say a
few seconds ago.

### When sync stops working

| Symptom | Fix |
|---|---|
| Worked yesterday, not today | Your Mac's IP changed. Use the `.local` address instead — it survives router reboots — or re-read the new one from `npm run lan`. |
| Nothing arrives at all | The Mac is asleep, or the firewall prompt was denied. |
| Everything 401s | The token in the phone doesn't match `INGEST_TOKEN`. Re-copy it from Settings. |

### Keeping it running

A laptop sleeps, and a sleeping Mac can't receive pushes. Health Auto Export
re-sends overlapping windows, so a short nap backfills itself on the next
successful push — but a week away leaves a gap you'll need an export to fill.

- System Settings → Battery → **Prevent automatic sleeping when the display is
  off**, while on power. Display sleep is fine; system sleep is not.
- Or `caffeinate -s npm run lan`, which holds it awake only while running.
- Closing the lid sleeps it regardless.

This is the honest cost of running it on a laptop instead of deploying it.

---

## Security

- **`npm run dev` is localhost-only.** `npm run lan` is the deliberate step that
  opens it to your network, and it refuses without a passphrase.
- If the app is reached from anything but the machine it runs on and no
  passphrase is set, it serves a 403 instead of your data.
- **Your WiFi is not a security boundary.** Guests are on it. So are devices you
  have forgotten about.
- LAN traffic is plain HTTP. The passphrase stops casual access, not someone
  determined who is already on your network.
- **Don't port-forward this or put it behind a public tunnel.** That publishes a
  complete medical record. If you want it reachable from anywhere, deploy it
  properly behind HTTPS with `APP_PASSWORD` set.

---

## Importing your history

Live sync only carries data from the day you connect your phone onward.
Everything before that comes from a one-time export:

1. Health.app → your photo (top right) → **Export All Health Data**
2. Get `export.zip` onto the machine running this app
3. `npm run import -- /path/to/export.zip`

Safe to run on top of live sync, and safe to run twice — both paths converge
on the same upsert. `--since=2024-01-01` limits how far back it goes;
`--routes` keeps workout GPS traces, which are dropped by default.

Delete the export afterwards. It's your complete medical history in plaintext.

> If you ingested data before this version, run `npm run repair-grain` once.
> See the note under [grain](#grain-prevents-a-double-count-across-the-two-ingest-paths).

---

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | First-run setup. Safe to re-run; `-- --merge` fills in missing keys |
| `npm run dev` | Start it, this machine only |
| `npm run lan` | Start it so your phone can reach it. Refuses without a passphrase |
| `npm test` | Full test suite |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run seed` | Generate synthetic history (`-- --days=N --reset`) |
| `npm run replay` | POST every fixture at a running server and assert the ingest contract |
| `npm run coach -- "..."` | Ask the real coach from the CLI; prints every tool call and cache hit rate |
| `npm run import -- <export.zip>` | Backfill your full Apple Health history |
| `npm run repair-grain` | One-time fix for data ingested before hourly buckets were detected |
| `npm run gen-export -- --mb=500` | Generate a synthetic `export.xml` for the memory test |
| `node scripts/gen-icons.mjs` | Regenerate PWA icons from the source SVG |
| `npm run db:push` | Apply schema changes |
| `npx drizzle-kit generate` | Write a migration file |

`npm run replay` is the check to run after touching anything in
`src/lib/hae/` — it's the closest thing to a real phone push available without
an iPhone.

---

## Architecture notes

A handful of decisions carry most of the weight. Each fixes a bug that would
otherwise be silent — producing plausible-looking wrong numbers rather than an
error.

### One fact table, not 150

`metric_types` is a registry and `metric_points` is a single fact table, so 150+
heterogeneous Apple Health metrics cost 150 rows rather than 150 tables. Custom
trackers later are just another registry row.

An unrecognised metric key is **never rejected** — it auto-registers and records
a warning. Apple ships new metric types regularly, and you can't go back and
re-fetch a year you dropped.

### Ingest upserts, never inserts

Health Auto Export re-sends overlapping windows on **every** push, so the same
sample arrives many times. Ingest upserts against
`(metric_type_id, grain, start_at, source_name)`. Blind inserts would inflate
every additive metric without ever looking wrong enough to notice.

### `grain` prevents a double-count across the two ingest paths

Apple's `export.xml` carries **raw per-sample** records; Health Auto Export
sends **hourly aggregates**. A raw sample at 08:03 and the hourly bucket
covering 08:00 don't collide on any natural key — so without protection, both
land and the daily rollup adds them together. Backfill your history into a live
database and every step count silently doubles.

So `grain` is part of the uniqueness key, and `daily_metrics` picks exactly one
grain per (metric, day) by precedence (`sample` > `hourly` > `daily`) rather
than summing across them. `src/db/rollups.test.ts` covers this directly, and
`src/lib/import/convergence.test.ts` runs both ingest paths into one database
and asserts the daily total doesn't move.

**Getting the label right turned out to be the hard part.** Health Auto Export
sends an hourly bucket as `{date, qty}` with *no end date*, so inferring grain
from a point's own span saw zero width and called every bucket a raw sample —
which made the protection above inert. One point can't say what window it
covers; a series of them can. Buckets arrive evenly spaced and sitting exactly
on the hour, and raw samples do neither, so grain is inferred per series
(`inferSeriesGrain`). Both signals are required, so a scale read at 07:00 every
morning isn't mistaken for a daily aggregate. Set `HAE_AGGREGATION=hourly` to
state it outright — the only genuinely ambiguous case is a push carrying a
single bucket.

If you ran an earlier build, `npm run repair-grain` relabels the affected rows.
It matters: `sample` outranks `hourly`, so mislabelled rows keep winning and
correct data pushed afterwards is silently ignored for the days they cover.

### Local days, not UTC days

Samples are UTC instants, but every "per day" figure is a local-day question.
Each point stores a `local_date` derived from **its own** UTC offset, so a run
at 23:30 in Tokyo files under the Tokyo date. Day ranges are derived from the
next day's start rather than by adding 24h, which gives correct 23- and 25-hour
days across DST.

`new Date()` is never used on a Health Auto Export timestamp — the
space-separated `2026-08-26 14:30:00 -0700` form is not ISO 8601, parses
differently across engines, and discards the offset that decides the local day.
See `src/lib/hae/dates.ts`.

### The AI coach never gets your data in a prompt

150 metrics across years of daily values is roughly 2.7 million tokens, so none
of it can go in a prompt. The coach starts with nothing and calls tools to
fetch exactly what it needs. Measured on seeded data, a full answer to "how did
I sleep last week vs the week before?" costs about **1,350 tokens** against
~495,000 for the raw dailies.

Statistics are computed in TypeScript, never by the model — a fabricated
correlation coefficient is exactly the confident-sounding wrong answer that
would make the feature worse than useless. There is deliberately no SQL tool: a
fixed set of parameterised functions is the safety model.

The tool trace is shown in the UI, so you can see precisely which parts of your
data each answer read.

### The history import streams, and is bounded by batch size

A real `export.xml` is a single XML document of a few hundred megabytes holding
millions of `<Record>` elements. A DOM parse needs the whole tree resident and
dies, so the importer is SAX (`saxes`) reading through a streaming unzip
(`yauzl`) — one element at a time, then forgotten.

Backpressure is the part that actually matters. The parser's consumer returns a
promise and the read stream is paused until it settles. Without that, SAX
parses at disk speed while SQLite writes at database speed, and the difference
accumulates in memory until the process dies — the exact failure streaming was
meant to avoid.

Verified against a generated 500MB export: **2.15M records in 64s, peak RSS
85MB**, running under `--max-old-space-size=256`. Reproduce it with
`npm run gen-export -- --mb=500`.

`HKQuantityTypeIdentifierStepCount` is mapped to `step_count` so both ingest
paths land on the same metric. Without that table the backfill would register
its own metric types and sit in rows no chart reads and no rollup touches — it
would appear to work and produce nothing.

### Units are canonicalised per metric, not per dimension

Values convert to a metric's own storage unit at ingest, and back out only at
render time. Per-metric matters: sodium belongs in mg and body weight in kg,
and both are "mass" — using one unit per dimension would render 100g of protein
as "0.1 g".

---

## Privacy

- `data/`, `*.db`, and `.env.local` are gitignored, verified with
  `git check-ignore`. This repository is public.
- Workout **GPS routes are not stored** unless `HAE_STORE_ROUTES=1`. Location
  history is the most sensitive thing in the payload and nothing renders it yet.
- Raw payloads are archived to `data/raw/*.json.gz` before parsing, so a parser
  bug can be fixed and replayed rather than losing data. Set
  `KEEP_RAW_PAYLOADS=0` to turn this off.
- Journal entries can be marked private and are then withheld from the AI coach
  entirely — enforced in the SQL of `listJournalForAI`, not by asking the model
  nicely.
- The service worker **never caches `/api/*`**. A stale health number is worse
  than none, and cached responses would leave a copy of your medical data in
  Cache Storage.
- Auth is enforced in the `(app)` route group's layout, not only in `proxy.ts`.
  The proxy just checks a cookie exists — a forged one gets past it and is
  rejected by the layout, where the data is actually read.
- Delete `export.zip` after importing it. It contains your complete medical
  history in plaintext, and the importer never copies it anywhere.
- Workout GPS routes inside `export.zip` are skipped unless you pass
  `--routes`, for the same reason they're off in live sync.

---

## Development gotchas

**Don't delete `data/life.db` while the dev server is running.** SQLite notices
the file was replaced under its open connection and returns
`SQLITE_READONLY_DBMOVED` on every write until you restart. Stop the server
first.

---

## Not medical advice

This is a personal tracking tool. The AI coach is instructed not to diagnose and
to point you at a clinician for anything concerning, but it is a language model
reading consumer-device data, not a doctor.
