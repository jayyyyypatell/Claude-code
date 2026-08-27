import type Anthropic from "@anthropic-ai/sdk";

import { client } from "@/db/index";
import {
  COACH_MODEL,
  MAX_ITERATIONS,
  MAX_TOOL_RESULT_BYTES,
  coachIsConfigured,
  getAnthropic,
  isMockMode,
} from "@/lib/ai/client";
import { runMockCoach } from "@/lib/ai/mock";
import { buildPromptContext, buildSystemPrompt } from "@/lib/ai/system-prompt";
import { coachTools } from "@/lib/ai/tools";
import { todayLocal } from "@/lib/time/day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The coach's chat endpoint.
 *
 * Streams Server-Sent Events so text appears as it is generated — a question
 * that involves four tool calls can take fifteen seconds, and a spinner for
 * fifteen seconds feels broken.
 *
 * Three event types go down the wire:
 *   `text`  — a token delta
 *   `tool`  — a tool was called (shown as a collapsible trace, so the user can
 *             see exactly which of their data was read)
 *   `done`  — the turn finished, with the assistant's full content blocks
 *   `error` — something failed, with a message worth reading
 */

interface ChatRequest {
  conversationId?: string;
  message?: string;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: Request): Promise<Response> {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const message = (body.message ?? "").trim();
  if (!message) {
    return Response.json({ error: "Empty message." }, { status: 400 });
  }
  if (message.length > 4000) {
    return Response.json({ error: "Message too long." }, { status: 413 });
  }

  if (!coachIsConfigured()) {
    return Response.json(
      {
        error:
          "The coach needs an Anthropic API key. Add ANTHROPIC_API_KEY to " +
          ".env.local (get one at console.anthropic.com), or set " +
          "AI_PROVIDER=mock to try the interface without one.",
      },
      { status: 503 },
    );
  }

  const conversationId = body.conversationId?.slice(0, 64) || crypto.randomUUID();

  /* ------------------------------------------------------ conversation --- */
  // Full content blocks are replayed, not text: a turn containing `tool_use`
  // must go back to the API exactly as it came out, or the next turn is
  // rejected for referencing a tool call it can't see.
  const history = await client.execute({
    sql: `SELECT role, content FROM chat_messages
          WHERE conversation_id = ? ORDER BY id LIMIT 40`,
    args: [conversationId],
  });

  const messages: Anthropic.Beta.BetaMessageParam[] = history.rows.map((r) => ({
    role: String(r.role) as "user" | "assistant",
    content: JSON.parse(String(r.content)) as Anthropic.Beta.BetaContentBlockParam[],
  }));

  /**
   * Today's date rides on the first user message, never the system prompt.
   *
   * A date in the cached prefix would invalidate the cache at midnight every
   * single day — the cache would appear to be configured and never once hit.
   */
  const today = todayLocal();
  const userContent: Anthropic.Beta.BetaContentBlockParam[] = [
    { type: "text", text: `(Today is ${today}.)\n\n${message}` },
  ];
  messages.push({ role: "user", content: userContent });

  await client.execute({
    sql: `INSERT INTO chat_messages (conversation_id, role, content)
          VALUES (?, 'user', ?)`,
    args: [conversationId, JSON.stringify(userContent)],
  });

  const ctx = await buildPromptContext();
  const system = buildSystemPrompt(ctx);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(sse(event, data)));
      };

      send("start", { conversationId });

      try {
        if (isMockMode()) {
          await runMockCoach(message, today, send);
          controller.close();
          return;
        }

        const anthropic = getAnthropic();
        let toolBytes = 0;

        const runner = anthropic.beta.messages.toolRunner({
          model: COACH_MODEL,
          max_tokens: 8000,
          system: [
            {
              type: "text",
              text: system,
              // The breakpoint. Everything above is byte-stable across turns.
              cache_control: { type: "ephemeral" },
            },
          ],
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          tools: coachTools,
          messages,
          max_iterations: MAX_ITERATIONS,
          stream: true,
        });

        let finalContent: Anthropic.Beta.BetaContentBlock[] = [];

        for await (const messageStream of runner) {
          messageStream.on("text", (delta) => send("text", { delta }));

          const msg = await messageStream.finalMessage();
          finalContent = msg.content;

          for (const block of msg.content) {
            if (block.type === "tool_use") {
              send("tool", { name: block.name, input: block.input });
            }
          }

          // The runner does not auto-resume a paused turn; without this a long
          // run ends early and silently, looking like a truncated answer.
          if (msg.stop_reason === "pause_turn") {
            runner.pushMessages({ role: "assistant", content: msg.content });
            continue;
          }

          if (msg.stop_reason === "refusal") {
            send("error", {
              message:
                "The model declined to answer that. Try rephrasing, or ask " +
                "about your data more directly.",
            });
            break;
          }

          // Backstop against a model that keeps pulling long series.
          toolBytes += JSON.stringify(msg.content).length;
          if (toolBytes > MAX_TOOL_RESULT_BYTES) {
            send("error", {
              message:
                "That question pulled in more data than one answer can hold. " +
                "Try narrowing the date range or asking about fewer metrics.",
            });
            break;
          }
        }

        if (finalContent.length > 0) {
          await client.execute({
            sql: `INSERT INTO chat_messages (conversation_id, role, content)
                  VALUES (?, 'assistant', ?)`,
            args: [conversationId, JSON.stringify(finalContent)],
          });
        }

        send("done", { conversationId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Surfaced rather than swallowed: an auth failure or a rate limit is
        // something the user can actually act on.
        send("error", { message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
