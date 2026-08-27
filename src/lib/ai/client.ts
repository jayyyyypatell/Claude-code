import Anthropic from "@anthropic-ai/sdk";

/**
 * The Anthropic client, plus the guardrails that keep a runaway loop from
 * costing real money.
 */

/**
 * Claude Opus 5.
 *
 * The coach's job is multi-step reasoning over the user's own data — decide
 * what to look up, look it up, notice what's unusual, and say something
 * specific about it. That is exactly where a weaker model produces
 * confident-sounding nonsense about someone's health.
 */
export const COACH_MODEL = "claude-opus-5";

/**
 * Iterations before the loop is cut off.
 *
 * Twelve is generous for a well-posed question (list, stats, maybe a
 * correlation and a journal read). A run that exceeds it is looping, not
 * working.
 */
export const MAX_ITERATIONS = 12;

/**
 * Cumulative tool-result budget for one turn.
 *
 * Individual tools cap their own output, but nothing stops a model calling
 * `metric_series` eleven times. This is the backstop.
 */
export const MAX_TOOL_RESULT_BYTES = 60_000;

let cached: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (cached) return cached;
  // Zero-arg construction: the SDK resolves ANTHROPIC_API_KEY (or an `ant auth
  // login` profile) itself, so no key is ever hardcoded or logged.
  cached = new Anthropic();
  return cached;
}

/** Whether the coach can run at all. Surfaced in the UI rather than as a 500. */
export function coachIsConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY) || isMockMode();
}

/**
 * Mock mode.
 *
 * Set `AI_PROVIDER=mock` to develop the chat UI — streaming, tool traces,
 * markdown rendering, error states — without an API key and without spending
 * tokens on layout work. It reads the same query layer, so the numbers it
 * quotes are real; only the language model is faked.
 */
export function isMockMode(): boolean {
  return process.env.AI_PROVIDER === "mock";
}
