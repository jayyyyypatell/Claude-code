"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { MetricLineChart, type LinePoint } from "@/components/charts/MetricLineChart";
import { formatValue, unitLabel } from "@/lib/format";
import type { MetricCategory } from "@/lib/metrics/catalog";

/**
 * The metric explorer.
 *
 * Filters sit in one row above the chart, and the selection lives in the URL —
 * so a particular view is linkable and survives a refresh, and the server can
 * do the querying rather than shipping every metric's history to the browser.
 */

interface MetricOption {
  key: string;
  displayName: string;
  category: MetricCategory;
  unit: string;
}

interface Props {
  metrics: MetricOption[];
  selectedKey: string;
  range: string;
  series: LinePoint[];
  rolling: (number | null)[];
  unit: string;
  displayName: string;
  agg: string;
  stats: {
    mean: number | null;
    min: number | null;
    max: number | null;
    n: number;
    days: number;
    changePct: number | null;
  } | null;
}

const RANGES = ["7d", "30d", "90d", "1y"] as const;

const CATEGORY_LABELS: Record<string, string> = {
  activity: "Activity",
  vitals: "Vitals",
  body: "Body",
  nutrition: "Nutrition",
  mindfulness: "Mind",
  sleep: "Sleep",
  other: "Other",
};

export function TrendExplorer({
  metrics,
  selectedKey,
  range,
  series,
  rolling,
  unit,
  displayName,
  agg,
  stats,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState("");

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(searchParams.toString());
    next.set(key, value);
    router.push(`/trends?${next.toString()}`);
  };

  const grouped = useMemo(() => {
    const filtered = query
      ? metrics.filter((m) =>
          m.displayName.toLowerCase().includes(query.toLowerCase()),
        )
      : metrics;

    const byCategory = new Map<string, MetricOption[]>();
    for (const m of filtered) {
      const list = byCategory.get(m.category) ?? [];
      list.push(m);
      byCategory.set(m.category, list);
    }
    return [...byCategory.entries()];
  }, [metrics, query]);

  // Counters read from zero; a heart rate axis starting at zero wastes most of
  // the plot and flattens the variation that matters.
  const zeroBased = agg === "sum";

  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        Trends
      </h1>

      {/* Filters in one row above the chart. */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search metrics…"
          aria-label="Search metrics"
          className="min-w-[10rem] flex-1 rounded-lg border px-3 py-1.5 text-sm outline-none"
          style={{
            background: "var(--surface)",
            borderColor: "var(--hairline)",
            color: "var(--ink)",
          }}
        />
        <div
          className="flex overflow-hidden rounded-lg border"
          style={{ borderColor: "var(--hairline)" }}
        >
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setParam("range", r)}
              aria-pressed={range === r}
              className="px-3 py-1.5 text-sm transition-colors"
              style={{
                background: range === r ? "var(--series-1)" : "var(--surface)",
                color: range === r ? "#fff" : "var(--ink-2)",
              }}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[13rem_1fr]">
        {/* metric rail */}
        <div
          className="max-h-[22rem] overflow-y-auto rounded-xl border p-2 md:max-h-[32rem]"
          style={{
            background: "var(--surface)",
            borderColor: "var(--hairline)",
          }}
        >
          {grouped.length === 0 && (
            <p className="p-2 text-sm" style={{ color: "var(--ink-muted)" }}>
              Nothing matches &ldquo;{query}&rdquo;.
            </p>
          )}
          {grouped.map(([category, list]) => (
            <div key={category} className="mb-2">
              <div
                className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide"
                style={{ color: "var(--ink-muted)" }}
              >
                {CATEGORY_LABELS[category] ?? category}
              </div>
              {list.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setParam("metric", m.key)}
                  aria-current={m.key === selectedKey ? "true" : undefined}
                  className="block w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors"
                  style={{
                    background:
                      m.key === selectedKey ? "var(--surface-2)" : "transparent",
                    color:
                      m.key === selectedKey ? "var(--ink)" : "var(--ink-2)",
                    fontWeight: m.key === selectedKey ? 500 : 400,
                  }}
                >
                  {m.displayName}
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* chart */}
        <div
          className="rounded-xl border p-4"
          style={{
            background: "var(--surface)",
            borderColor: "var(--hairline)",
          }}
        >
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <div>
              {/* Single series — the title names it, so no legend box. */}
              <h2
                className="text-base font-medium"
                style={{ color: "var(--ink)" }}
              >
                {displayName}
              </h2>
              <p className="text-xs" style={{ color: "var(--ink-muted)" }}>
                {unitLabel(unit) || "count"} · daily{" "}
                {agg === "sum" ? "total" : agg === "last" ? "reading" : "average"}
                {rolling.some((v) => v !== null) && " · faint line is the trend"}
              </p>
            </div>
          </div>

          {series.some((p) => p.value !== null) ? (
            <>
              <MetricLineChart
                points={series}
                rolling={rolling}
                unit={unit}
                label={displayName}
                zeroBased={zeroBased}
              />

              {stats && (
                <dl
                  className="mt-4 grid grid-cols-2 gap-3 border-t pt-3 sm:grid-cols-4"
                  style={{ borderColor: "var(--hairline)" }}
                >
                  <Stat label="Average" value={formatValue(stats.mean, unit)} />
                  <Stat label="Lowest" value={formatValue(stats.min, unit)} />
                  <Stat label="Highest" value={formatValue(stats.max, unit)} />
                  <Stat
                    label="Days with data"
                    value={`${stats.n} of ${stats.days}`}
                  />
                </dl>
              )}
            </>
          ) : (
            <p className="py-8 text-sm" style={{ color: "var(--ink-muted)" }}>
              No readings for {displayName} in this range.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs" style={{ color: "var(--ink-muted)" }}>
        {label}
      </dt>
      <dd
        className="tabular text-sm font-medium"
        style={{ color: "var(--ink)" }}
      >
        {value}
      </dd>
    </div>
  );
}
