# Life Tracker

A personal life tracker that pulls everything out of Apple Health automatically,
adds habits and a daily journal, and puts an AI coach on top that can actually
read your data.

It's a Next.js web app you install to your iPhone home screen. Your phone pushes
health data to it several times a day on its own — no manual exporting.

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
| M7 — export.zip backfill | ⏳ next |

---

## Getting started

```bash
npm install
cp .env.example .env.local          # then fill it in — see below
npx drizzle-kit push                # create the database
npm run seed -- --days=550 --reset  # 18 months of realistic fake data
npm run dev
```

### Configuring `.env.local`

Generate an ingest token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`USER_TIMEZONE` matters more than it looks. Every "per day" number is bucketed
against a local day, so setting it wrong shifts steps and sleep onto
neighbouring days.

**Before putting this anywhere reachable**, set `APP_PASSWORD` and a 32+
character `SESSION_SECRET`. Without them the app runs with no login at all,
which is right on your own machine and wrong everywhere else — this holds your
complete health history. The settings page says so in red when it's unset.

For the AI coach, add `ANTHROPIC_API_KEY`. To try the interface first without
spending anything, set `AI_PROVIDER=mock`: it reads your real data through the
same query layer and returns canned wording, so no numbers are invented.

---

## Connecting your iPhone

Your phone can't reach `localhost`, so you need a public HTTPS URL first.

**For testing** — a free tunnel, no account needed:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

**For daily use**, deploy it. `DATABASE_URL` accepts a hosted
[Turso](https://turso.tech) `libsql://` URL with no code changes, which is what
makes serverless hosting work.

> Don't leave your health data behind a random public tunnel URL long-term.
> Fine for an afternoon of testing; not a deployment.

Then, in **Health Auto Export** on your iPhone:

1. Automations → add a **REST API** automation
2. URL: `https://<your-host>/api/ingest/hae`
3. Method **POST**, format **JSON**
4. Add header `x-ingest-token` with your `INGEST_TOKEN`
5. Select the metrics you want (or all of them)
6. Set aggregation to **hourly** and an interval of 1–4 hours

Use the app's test button to check the connection — `GET /api/ingest/hae` with
the same token returns your current totals.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm test` | Full test suite |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run seed` | Generate synthetic history (`-- --days=N --reset`) |
| `npm run replay` | POST every fixture at a running server and assert the ingest contract |
| `npm run coach -- "..."` | Ask the real coach from the CLI; prints every tool call and cache hit rate |
| `node scripts/gen-icons.mjs` | Regenerate PWA icons from the source SVG |
| `npx drizzle-kit push` | Apply schema changes |
| `npx drizzle-kit generate` | Write a migration file |

`npm run replay` is the check to run after touching anything in
`src/lib/hae/` — it's the closest thing to a real phone push available without
an iPhone.

---

## Architecture notes

Three decisions carry most of the weight. Each fixes a bug that would otherwise
be silent — producing plausible-looking wrong numbers rather than an error.

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
than summing across them. `src/db/rollups.test.ts` covers this directly.

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
  history in plaintext.

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
