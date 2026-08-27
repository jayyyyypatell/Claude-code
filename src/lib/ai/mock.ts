import { addDays, todayLocal } from "@/lib/time/day";

import {
  toolCorrelate,
  toolGetSleep,
  toolMetricStats,
} from "./queries";

/**
 * A stand-in coach that calls the real tools but doesn't call the API.
 *
 * This exists so the chat interface — streaming, the tool trace, error states,
 * scroll behaviour — can be built and reviewed without an API key and without
 * spending tokens on layout work. Crucially it reads the **same query layer**
 * as the real coach, so every number it quotes is genuinely from the database;
 * only the prose is canned.
 *
 * It is not a fallback. If no key is configured the app says so plainly rather
 * than quietly serving fake insight about someone's health — which would be a
 * genuinely bad thing to do.
 */

type Send = (event: string, data: unknown) => void;

/** Stream text at a readable pace so the UI's streaming path is exercised. */
async function streamText(text: string, send: Send): Promise<void> {
  for (const word of text.split(/(\s+)/)) {
    send("text", { delta: word });
    await new Promise((r) => setTimeout(r, 12));
  }
}

export async function runMockCoach(
  message: string,
  today: string,
  send: Send,
): Promise<void> {
  const asks = (re: RegExp): boolean => re.test(message.toLowerCase());

  const weekAgo = addDays(today, -6);
  const twoWeeksAgo = addDays(today, -13);
  const monthAgo = addDays(today, -29);
  const quarterAgo = addDays(today, -89);

  await streamText("*(Mock mode — real numbers from your database, canned wording. Set `ANTHROPIC_API_KEY` for the real coach.)*\n\n", send);

  if (asks(/sleep/)) {
    send("tool", {
      name: "get_sleep",
      input: { start_date: twoWeeksAgo, end_date: today },
    });
    const thisWeek = await toolGetSleep({ start_date: weekAgo, end_date: today });
    const lastWeek = await toolGetSleep({
      start_date: twoWeeksAgo,
      end_date: addDays(weekAgo, -1),
    });

    send("tool", {
      name: "correlate",
      input: {
        metric_a: "sleep",
        metric_b: "resting_heart_rate",
        lag_days: 1,
        start_date: quarterAgo,
        end_date: today,
      },
    });
    const corr = await toolCorrelate({
      metric_a: "sleep",
      metric_b: "resting_heart_rate",
      start_date: quarterAgo,
      end_date: today,
      lag_days: 1,
    });

    const a = thisWeek.average_hours as number | null;
    const b = lastWeek.average_hours as number | null;
    const delta = a != null && b != null ? a - b : null;

    // No nights recorded is not a measurement of zero. Saying "you averaged 0h,
    // essentially flat" about an empty database is worse than saying nothing,
    // and this is the state every new install starts in.
    if (!thisWeek.nights_recorded) {
      await streamText(
        "I don't have any sleep data yet.\n\n" +
          "Connect your phone from **Settings**, or import your history with " +
          "`npm run import -- ~/Downloads/export.zip`. Once a few nights are in, " +
          "ask me again and I'll compare them.",
        send,
      );
      send("done", {});
      return;
    }

    // The correlation needs enough paired days to mean anything; `toolCorrelate`
    // already decides that and says so in `caveat`. Repeating its number as
    // prose regardless is how "r = null" reached the screen.
    const correlationLine =
      corr.r != null && Number(corr.n) >= 20
        ? `\n\nAcross the last 90 days, your sleep and next-day resting heart rate correlate at **r = ${corr.r}** (${corr.strength}, n = ${corr.n}). ` +
          `Shorter nights go with a higher resting heart rate the following day.\n\n_${corr.caveat}_`
        : `\n\n_Not enough paired days yet to say how this tracks against your resting heart rate._`;

    await streamText(
      `You averaged **${a ?? "—"}h** over the last 7 nights` +
        (b != null ? `, against **${b}h** the week before` : "") +
        (delta != null
          ? ` — ${Math.abs(delta) < 0.2 ? "essentially flat" : delta > 0 ? `up ${delta.toFixed(1)}h` : `down ${Math.abs(delta).toFixed(1)}h`}.`
          : ".") +
        correlationLine,
      send,
    );
    send("done", {});
    return;
  }

  if (asks(/step|activ|exercise|move/)) {
    send("tool", {
      name: "metric_stats",
      input: {
        metric_keys: ["step_count", "active_energy", "apple_exercise_time"],
        start_date: monthAgo,
        end_date: today,
      },
    });
    const stats = await toolMetricStats({
      metric_keys: ["step_count", "active_energy", "apple_exercise_time"],
      start_date: monthAgo,
      end_date: today,
    });

    const lines = (stats.stats as Record<string, unknown>[])
      .map(
        (s) =>
          `- **${s.name}**: ${s.mean} ${s.unit} on average` +
          (s.change_pct != null
            ? ` (${Number(s.change_pct) > 0 ? "+" : ""}${s.change_pct}% vs the previous 30 days)`
            : ""),
      )
      .join("\n");

    await streamText(`Over the last 30 days:\n\n${lines}\n`, send);
    send("done", {});
    return;
  }

  send("tool", {
    name: "metric_stats",
    input: {
      metric_keys: ["resting_heart_rate", "heart_rate_variability", "step_count"],
      start_date: monthAgo,
      end_date: today,
    },
  });
  const stats = await toolMetricStats({
    metric_keys: ["resting_heart_rate", "heart_rate_variability", "step_count"],
    start_date: monthAgo,
    end_date: today,
  });

  const lines = (stats.stats as Record<string, unknown>[])
    .map((s) => `- **${s.name}**: ${s.mean} ${s.unit}`)
    .join("\n");

  await streamText(
    `Here's where you are over the last 30 days:\n\n${lines}\n\n` +
      `Ask me about your sleep, your activity, or how one thing relates to another.`,
    send,
  );
  send("done", {});
}

/** Used by the smoke-test script to pick a default date. */
export const mockToday = (): string => todayLocal();
