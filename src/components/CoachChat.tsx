"use client";

import { useEffect, useRef, useState } from "react";

import { renderCoachMarkdown } from "@/lib/ai/markdown";

/**
 * The coach chat.
 *
 * Two deliberate choices:
 *
 * **The tool trace is visible.** Every call the coach makes into your data is
 * shown, collapsed, with its arguments. You can see that it read your sleep
 * for a specific fortnight and nothing else. For a thing rummaging through
 * your health record, "trust me" is not good enough — and it doubles as the
 * fastest way to tell a real answer from a hallucinated one.
 *
 * **Text streams.** A question involving four tool calls can take fifteen
 * seconds, and fifteen seconds of spinner reads as broken.
 */

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

interface Turn {
  role: "user" | "assistant";
  text: string;
  tools: ToolCall[];
  error?: string;
}

const SUGGESTIONS = [
  "How did I sleep last week vs the week before?",
  "What's my resting heart rate doing?",
  "Does my sleep affect my next day?",
  "How are my habits going?",
];

export function CoachChat({ configured }: { configured: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const conversationId = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  async function send(text: string): Promise<void> {
    const question = text.trim();
    if (!question || busy) return;

    setInput("");
    setBusy(true);
    setTurns((t) => [
      ...t,
      { role: "user", text: question, tools: [] },
      { role: "assistant", text: "", tools: [] },
    ]);

    /** Mutate only the final (assistant) turn as events arrive. */
    const patch = (fn: (turn: Turn) => Turn): void => {
      setTurns((t) => {
        const next = [...t];
        next[next.length - 1] = fn(next[next.length - 1]);
        return next;
      });
    };

    try {
      const res = await fetch("/api/coach/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: question,
          conversationId: conversationId.current,
        }),
      });

      if (!res.ok || !res.body) {
        const detail = await res.json().catch(() => ({ error: res.statusText }));
        patch((turn) => ({ ...turn, error: String(detail.error ?? "Request failed") }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Manual SSE parse: events are separated by a blank line, and a chunk
      // boundary can land mid-event, so anything after the last separator
      // stays buffered rather than being parsed as truncated JSON.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const eventLine = part.split("\n").find((l) => l.startsWith("event: "));
          const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
          if (!eventLine || !dataLine) continue;

          const event = eventLine.slice(7).trim();
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(dataLine.slice(6));
          } catch {
            continue;
          }

          if (event === "start" && typeof data.conversationId === "string") {
            conversationId.current = data.conversationId;
          } else if (event === "text") {
            patch((turn) => ({ ...turn, text: turn.text + String(data.delta ?? "") }));
          } else if (event === "tool") {
            patch((turn) => ({
              ...turn,
              tools: [
                ...turn.tools,
                {
                  name: String(data.name),
                  input: (data.input ?? {}) as Record<string, unknown>,
                },
              ],
            }));
          } else if (event === "error") {
            patch((turn) => ({ ...turn, error: String(data.message ?? "Something went wrong") }));
          }
        }
      }
    } catch (err) {
      patch((turn) => ({
        ...turn,
        error: err instanceof Error ? err.message : "Network error",
      }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!configured && (
        <div
          className="rounded-xl border p-4 text-sm"
          style={{
            background: "var(--surface)",
            borderColor: "var(--hairline)",
            color: "var(--ink-2)",
          }}
        >
          <p className="mb-2 font-medium" style={{ color: "var(--ink)" }}>
            The coach needs an API key
          </p>
          <p>
            Add <code>ANTHROPIC_API_KEY</code> to <code>.env.local</code> — get
            one at console.anthropic.com. To try the interface first, set{" "}
            <code>AI_PROVIDER=mock</code>: it reads your real data and returns
            canned wording, so nothing is invented about your health.
          </p>
        </div>
      )}

      {turns.length === 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm" style={{ color: "var(--ink-2)" }}>
            Ask about anything the app tracks. The coach queries your data
            directly — you&rsquo;ll see exactly which parts it read.
          </p>
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => send(s)}
                disabled={busy}
                className="rounded-full border px-3 py-1.5 text-left text-xs transition-colors disabled:opacity-50"
                style={{
                  background: "var(--surface)",
                  borderColor: "var(--hairline)",
                  color: "var(--ink-2)",
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {turns.map((turn, i) => (
          <div key={i} className="flex flex-col gap-2">
            {turn.role === "user" ? (
              <div
                className="self-end rounded-2xl rounded-br-sm px-3.5 py-2 text-sm"
                style={{ background: "var(--series-1)", color: "#fff", maxWidth: "85%" }}
              >
                {turn.text}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {turn.tools.length > 0 && <ToolTrace tools={turn.tools} />}

                {turn.text && (
                  <div
                    className="whitespace-pre-wrap text-sm leading-relaxed"
                    style={{ color: "var(--ink)" }}
                  >
                    <Markdown text={turn.text} />
                  </div>
                )}

                {!turn.text && !turn.error && busy && (
                  <span className="text-sm" style={{ color: "var(--ink-muted)" }}>
                    Reading your data…
                  </span>
                )}

                {turn.error && (
                  <div
                    className="rounded-lg border p-3 text-sm"
                    style={{
                      borderColor: "var(--critical)",
                      color: "var(--ink-2)",
                      background: "var(--surface)",
                    }}
                  >
                    {turn.error}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="sticky bottom-20 flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your data…"
          aria-label="Ask the coach"
          disabled={busy}
          className="flex-1 rounded-xl border px-3.5 py-2.5 text-sm outline-none disabled:opacity-60"
          style={{
            background: "var(--surface)",
            borderColor: "var(--hairline)",
            color: "var(--ink)",
          }}
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-xl px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
          style={{ background: "var(--series-1)" }}
        >
          {busy ? "…" : "Ask"}
        </button>
      </form>
    </div>
  );
}

/** The collapsible record of which data was read. */
function ToolTrace({ tools }: { tools: ToolCall[] }) {
  return (
    <details
      className="rounded-lg border text-xs"
      style={{ background: "var(--surface-2)", borderColor: "var(--hairline)" }}
    >
      <summary
        className="cursor-pointer px-3 py-1.5"
        style={{ color: "var(--ink-muted)" }}
      >
        Read {tools.length} {tools.length === 1 ? "thing" : "things"} from your
        data
      </summary>
      <ul className="flex flex-col gap-1 px-3 pb-2">
        {tools.map((t, i) => (
          <li key={i} style={{ color: "var(--ink-2)" }}>
            <code>{t.name}</code>
            {Object.keys(t.input).length > 0 && (
              <span style={{ color: "var(--ink-muted)" }}>
                {" "}
                {Object.entries(t.input)
                  .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`)
                  .join(" ")}
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Markdown({ text }: { text: string }) {
  // Renderer lives in `@/lib/ai/markdown` so it can be tested directly — it
  // handles untrusted model output and has one genuinely subtle rule about
  // underscores in metric keys.
  return <span dangerouslySetInnerHTML={{ __html: renderCoachMarkdown(text) }} />;
}
