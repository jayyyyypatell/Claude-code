/**
 * Ask the real coach a question from the command line and print everything it
 * did — every tool call, its arguments, the size of each result, and the token
 * usage for the turn.
 *
 * This is the check to run after touching anything in `src/lib/ai/`, and the
 * fastest way to see whether the tool descriptions are steering the model
 * sensibly: if it reaches for `metric_series` where `metric_stats` would do,
 * that's a prompt problem, and you'll see it here rather than in a bill.
 *
 * Requires ANTHROPIC_API_KEY.
 *
 *   npm run coach -- "how did I sleep last week vs the week before?"
 */

import type Anthropic from "@anthropic-ai/sdk";

import { COACH_MODEL, MAX_ITERATIONS, getAnthropic } from "../src/lib/ai/client";
import { buildPromptContext, buildSystemPrompt } from "../src/lib/ai/system-prompt";
import { coachTools } from "../src/lib/ai/tools";
import { isMockMode } from "../src/lib/ai/client";
import { runMockCoach } from "../src/lib/ai/mock";
import { todayLocal } from "../src/lib/time/day";

const question =
  process.argv.slice(2).join(" ").trim() ||
  "How did I sleep last week compared with the week before, and did it show up anywhere else?";

async function main(): Promise<void> {
  // AI_PROVIDER=mock is documented as the way to exercise the coach without a
  // key, so the CLI has to honour it too — otherwise the one path that needs
  // no key is the one path you can't reach from here.
  if (isMockMode()) {
    console.log(`Q: ${question}`);
    console.log("   (mock provider — real data, canned wording)\n");
    await runMockCoach(question, todayLocal(), (event, data) => {
      if (event === "text") process.stdout.write((data as { delta: string }).delta);
      else if (event === "tool") console.log(`\n[tool] ${JSON.stringify(data)}`);
    });
    console.log("\n");
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set.\n" +
        "Get a key at console.anthropic.com and add it to .env.local, then:\n" +
        "  npm run coach -- \"your question\"\n",
    );
    process.exit(1);
  }

  const today = todayLocal();
  const ctx = await buildPromptContext();
  const system = buildSystemPrompt(ctx);

  console.log(`Q: ${question}`);
  console.log(`   (model ${COACH_MODEL}, today ${today})\n`);

  const started = Date.now();
  let iterations = 0;
  let toolCalls = 0;

  const runner = getAnthropic().beta.messages.toolRunner({
    model: COACH_MODEL,
    max_tokens: 8000,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    tools: coachTools,
    // Today's date goes here, not in the cached system prompt.
    messages: [
      { role: "user", content: `(Today is ${today}.)\n\n${question}` },
    ],
    max_iterations: MAX_ITERATIONS,
  });

  let last: Anthropic.Beta.BetaMessage | null = null;

  for await (const message of runner) {
    iterations++;
    last = message;

    for (const block of message.content) {
      if (block.type === "tool_use") {
        toolCalls++;
        console.log(`  → ${block.name}(${JSON.stringify(block.input)})`);
      }
    }

    if (message.stop_reason === "pause_turn") {
      runner.pushMessages({ role: "assistant", content: message.content });
    }
  }

  const answer =
    last?.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n") ?? "(no text returned)";

  console.log(`\n${answer}\n`);
  console.log("─".repeat(60));
  console.log(
    `iterations ${iterations} · tool calls ${toolCalls} · ${(
      (Date.now() - started) / 1000
    ).toFixed(1)}s`,
  );

  const usage = last?.usage;
  if (usage) {
    console.log(
      `tokens: in ${usage.input_tokens} · out ${usage.output_tokens}` +
        ` · cache written ${usage.cache_creation_input_tokens ?? 0}` +
        ` · cache read ${usage.cache_read_input_tokens ?? 0}`,
    );
    // A second run of this script should show a non-zero cache read. If it
    // stays at zero, something in the system prompt is changing between turns
    // and the cache is silently doing nothing.
    if ((usage.cache_read_input_tokens ?? 0) === 0) {
      console.log(
        "note: no cache read — expected on a first run; if it persists, " +
          "something in the system prompt is varying between calls.",
      );
    }
  }
  if (last?.stop_reason === "refusal") {
    console.log(`stop_reason: refusal (${last.stop_details?.category ?? "unknown"})`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nFailed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
