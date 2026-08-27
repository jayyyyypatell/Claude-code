"use client";

import { useState } from "react";

/**
 * A value with a copy button, hidden by default when it's a secret.
 *
 * Hidden because settings pages get screenshotted and screen-shared, and an
 * ingest token in a screenshot is a write credential to someone's health
 * record. The reveal is deliberate rather than default.
 */
export function CopyField({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  const [revealed, setRevealed] = useState(!secret);
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; revealing lets them select manually.
      setRevealed(true);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs" style={{ color: "var(--ink-muted)" }}>
        {label}
      </span>
      <div className="flex gap-2">
        <code
          className="flex-1 overflow-x-auto rounded-lg border px-3 py-2 text-xs"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--hairline)",
            color: "var(--ink-2)",
          }}
        >
          {revealed ? value : "•".repeat(Math.min(value.length, 48))}
        </code>
        {secret && (
          <button
            type="button"
            onClick={() => setRevealed((r) => !r)}
            className="rounded-lg border px-3 text-xs"
            style={{
              borderColor: "var(--hairline)",
              color: "var(--ink-2)",
              background: "var(--surface)",
            }}
          >
            {revealed ? "Hide" : "Show"}
          </button>
        )}
        <button
          type="button"
          onClick={copy}
          className="rounded-lg px-3 text-xs font-medium text-white"
          style={{ background: "var(--series-1)" }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
