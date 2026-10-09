import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// One run at a time: two concurrent runs would spend the same owner's budget twice.
let busyUntil = 0;

const fail = (status: number, error: string, message: string) => Response.json({ error, message }, { status });

// Streams the agent's Server-Sent Events through unchanged, so the browser only
// ever talks to this origin.
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (!q) return fail(400, "bad_request", "Ask a question first.");
  if (q.length > 500) return fail(400, "bad_request", "The question is limited to 500 characters.");
  if (Date.now() < busyUntil) return fail(409, "run_in_progress", "A run is already in progress. Wait for it to finish.");

  let upstream: Response | undefined;
  // After a cold start the web app is up a few seconds before the agent, so retry
  // connection errors for a while instead of failing the first visitor.
  for (let waited = 0; !upstream; waited += 1000) {
    try {
      upstream = await fetch(`${env.agentUrl}/run?q=${encodeURIComponent(q)}`, {
        // The agent rate-limits per visitor, so it needs the visitor's address, not ours.
        headers: { Accept: "text/event-stream", "x-forwarded-for": req.headers.get("x-forwarded-for") ?? "local" },
        cache: "no-store",
        signal: req.signal,
      });
    } catch (e) {
      if (waited >= 30_000 || req.signal.aborted) {
        return fail(502, "agent_unreachable", `Could not reach the agent at ${env.agentUrl}. ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (upstream.status === 429) {
    const body = (await upstream.json().catch(() => ({}))) as { error?: string; message?: string };
    return fail(429, body.error ?? "rate_limited", body.message ?? "The demo agent is rate limited. Try again in a moment.");
  }
  if (!upstream.ok || !upstream.body) {
    return fail(502, "agent_error", `The agent answered HTTP ${upstream.status}.`);
  }

  busyUntil = Date.now() + 5 * 60_000;
  const release = () => {
    busyUntil = 0;
  };
  const reader = upstream.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (e) {
        release();
        controller.error(e);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
