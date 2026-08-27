/**
 * A minimal markdown renderer for coach replies.
 *
 * A full markdown library is a lot of bytes for the four constructs a chat
 * reply actually uses. It lives here rather than inside the component so it
 * can be tested directly — which matters, because it handles untrusted model
 * output and has one genuinely subtle rule (see the underscore case below).
 */
export function renderCoachMarkdown(text: string): string {
  // Escape FIRST. Every tag introduced below is ours; anything that arrives in
  // the text is inert by the time we get here.
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return (
    escaped
      // Code first, so a metric key inside backticks is never then parsed for
      // emphasis.
      .replace(
        /`([^`]+)`/g,
        '<code class="rounded px-1" style="background:var(--surface-2)">$1</code>',
      )
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      /**
       * Underscore italics, anchored to word boundaries.
       *
       * Apple Health metric keys are full of underscores — `step_count`,
       * `heart_rate_variability` — and the coach quotes them constantly. A
       * naive `_(.+?)_` rule matches from the middle of one key to the middle
       * of the next, swallowing both and italicising the prose between them.
       * Requiring whitespace before the opening underscore and a space or
       * punctuation after the closing one makes `_like this_` work while
       * leaving identifiers untouched.
       */
      .replace(/(^|\s)_([^_\n]+)_(?=[\s.,!?;:)]|$)/g, "$1<em>$2</em>")
      .replace(/^- (.+)$/gm, "<li>$1</li>")
      .replace(/(<li>[\s\S]*<\/li>)/, '<ul class="ml-4 list-disc">$1</ul>')
  );
}
