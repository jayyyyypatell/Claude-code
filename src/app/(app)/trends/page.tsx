import { TrendExplorer } from "@/components/TrendExplorer";
import {
  getMetricSeries,
  getMetricStats,
  listMetrics,
  rollingMean,
} from "@/db/queries/metrics";
import { addDays, todayLocal } from "@/lib/time/day";

export const dynamic = "force-dynamic";

/**
 * Trends.
 *
 * One generic explorer over every metric the registry knows about, rather than
 * a bespoke page per metric. The server does the querying and the rolling mean
 * so the client only receives a few hundred points — never the raw samples.
 */

const RANGES = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 } as const;
export type RangeKey = keyof typeof RANGES;

export default async function TrendsPage({
  searchParams,
}: {
  searchParams: Promise<{ metric?: string; range?: string }>;
}) {
  const params = await searchParams;
  const metrics = await listMetrics();

  if (metrics.length === 0) {
    return (
      <main className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--ink)" }}>
          Trends
        </h1>
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          No metrics yet. Once your phone pushes data — or you run{" "}
          <code>npm run seed</code> — everything it sends shows up here
          automatically.
        </p>
      </main>
    );
  }

  const selectedKey =
    metrics.find((m) => m.key === params.metric)?.key ?? metrics[0].key;
  const rangeKey: RangeKey =
    params.range && params.range in RANGES ? (params.range as RangeKey) : "30d";

  const today = todayLocal();
  const from = addDays(today, -(RANGES[rangeKey] - 1));

  const [series, stats] = await Promise.all([
    getMetricSeries(selectedKey, from, today),
    getMetricStats(selectedKey, from, today),
  ]);

  // A 7-day window is meaningless on a 7-day range; scale it to the span.
  const window = RANGES[rangeKey] >= 90 ? 14 : RANGES[rangeKey] >= 30 ? 7 : 3;

  return (
    <TrendExplorer
      metrics={metrics.map((m) => ({
        key: m.key,
        displayName: m.displayName,
        category: m.category,
        unit: m.unit,
      }))}
      selectedKey={selectedKey}
      range={rangeKey}
      series={series?.points ?? []}
      rolling={series ? rollingMean(series.points, window) : []}
      unit={series?.unit ?? ""}
      displayName={series?.displayName ?? ""}
      agg={series?.agg ?? "avg"}
      stats={
        stats && {
          mean: stats.mean,
          min: stats.min,
          max: stats.max,
          n: stats.n,
          days: stats.days,
          changePct: stats.changePct,
        }
      }
    />
  );
}
