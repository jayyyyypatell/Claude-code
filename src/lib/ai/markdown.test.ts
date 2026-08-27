import { describe, expect, it } from "vitest";

import { renderCoachMarkdown } from "./markdown";

/**
 * The coach's minimal markdown renderer.
 *
 * Two things are being protected here. The first is XSS: model output is
 * inserted with `dangerouslySetInnerHTML`, so escaping has to happen before
 * any tag is introduced, not after.
 *
 * The second is subtler and is why this file exists. Apple Health metric keys
 * are full of underscores — `step_count`, `heart_rate_variability` — and the
 * coach quotes them constantly. A naive `_(.+?)_` italic rule matches from the
 * middle of one key to the middle of the next, swallowing both keys and
 * italicising the prose between them.
 */

describe("emphasis", () => {
  it("renders bold and italic", () => {
    expect(renderCoachMarkdown("**6.78h**")).toContain("<strong>6.78h</strong>");
    expect(renderCoachMarkdown("that is *notable*")).toContain("<em>notable</em>");
    expect(renderCoachMarkdown("_a caveat here_")).toContain("<em>a caveat here</em>");
  });

  it("leaves metric keys alone", () => {
    // The exact failure mode: without word-boundary anchoring this becomes
    // "step<em>count and heart</em>rate_variability".
    const out = renderCoachMarkdown(
      "your step_count and heart_rate_variability both moved",
    );

    expect(out).toContain("step_count");
    expect(out).toContain("heart_rate_variability");
    expect(out).not.toContain("<em>");
  });

  it("leaves a lone trailing underscore alone", () => {
    const out = renderCoachMarkdown("the metric_key_ is odd");
    expect(out).not.toContain("<em>");
  });

  it("still italicises a real phrase next to metric keys", () => {
    const out = renderCoachMarkdown(
      "step_count rose. _Correlation, not causation._",
    );
    expect(out).toContain("step_count");
    expect(out).toContain("<em>Correlation, not causation.</em>");
  });
});

describe("code", () => {
  it("renders inline code", () => {
    expect(renderCoachMarkdown("set `AI_PROVIDER` to mock")).toContain("<code");
  });

  it("does not apply emphasis inside code", () => {
    // `resting_heart_rate` inside backticks must survive intact.
    const out = renderCoachMarkdown("call `correlate` on `resting_heart_rate`");
    expect(out).toContain("resting_heart_rate");
    expect(out).not.toContain("<em>");
  });
});

describe("lists", () => {
  it("renders bullets", () => {
    const out = renderCoachMarkdown("- one\n- two");
    expect(out).toContain("<ul");
    expect(out.match(/<li>/g)?.length).toBe(2);
  });
});

describe("escaping — model output is untrusted markup", () => {
  it("escapes HTML before introducing any tags", () => {
    const out = renderCoachMarkdown('<img src=x onerror="alert(1)">');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  it("escapes a script tag", () => {
    const out = renderCoachMarkdown("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("escapes markup hidden inside emphasis", () => {
    const out = renderCoachMarkdown("**<b>bold</b>**");
    expect(out).toContain("<strong>");
    // The inner tag is escaped text, not a real element.
    expect(out).toContain("&lt;b&gt;");
  });
});
