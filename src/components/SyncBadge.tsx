import { relativeTime } from "@/lib/format";

/**
 * "Last synced 12 minutes ago."
 *
 * The single most important element on a sync-based dashboard. iOS decides
 * when background automations actually run, so pushes can be hours late
 * through no fault of the app — and without this badge, a stale number is
 * indistinguishable from a current one. That uncertainty quietly undermines
 * every other figure on the screen.
 *
 * It also turns "is it broken?" into a question with an answer: a stale
 * timestamp means the phone hasn't pushed, while a warning state means a push
 * arrived and something in it didn't parse.
 */

interface Props {
  lastIngestAt: number | null;
  status: string | null;
  source: string | null;
  /**
   * Current time, supplied by the caller rather than read here.
   *
   * Reading the clock during render makes a component impure — its output
   * changes without its inputs changing. Passing it in keeps the badge a pure
   * function of its props, and makes "what does this look like after two days
   * of silence?" a thing you can just render.
   */
  now: number;
}

/** Health Auto Export pushes a few times a day; a day of silence is a problem. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function SyncBadge({ lastIngestAt, status, source, now }: Props) {
  const age = lastIngestAt ? now - lastIngestAt : null;
  const stale = age === null || age > STALE_AFTER_MS;
  const partial = status === "partial";

  const color = stale
    ? "var(--critical)"
    : partial
      ? "var(--warning)"
      : "var(--good)";

  const detail =
    source === "seed" ? "sample data" : relativeTime(lastIngestAt, now);

  return (
    <div
      className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
      style={{ borderColor: "var(--hairline)", background: "var(--surface)" }}
      title={
        stale
          ? "No push received in over a day. Check the automation in Health Auto Export."
          : partial
            ? "The last push arrived but some items could not be parsed."
            : "Your phone is syncing normally."
      }
    >
      {/* A dot AND text — status never rests on colour alone. */}
      <span
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: color }}
        aria-hidden="true"
      />
      <span style={{ color: "var(--ink-2)" }}>
        {lastIngestAt ? `Synced ${detail}` : "Never synced"}
      </span>
    </div>
  );
}
