// SSE response helper: takes an async iterable of JSON-able events and
// returns a Response with the right headers. Sends a heartbeat comment
// every 15 s to keep proxies from idling the connection.
//
// Generic over the event payload type so callers (chat streams, redeploy,
// etc.) get type-checked events without each rebuilding the encoding /
// heartbeat / error-frame contract.
//
// Two emission modes:
//   - Default: each iterable item is serialized whole as JSON in a single
//     `data:` line. Used by the redeploy stream.
//   - Id-tagged: pass `{ extractId, extractData }` to write a per-event
//     `id:` line so browsers populate the `Last-Event-ID` header on
//     auto-reconnect. Used by the chat turn stream.

// Base reconnect interval advertised to EventSource clients via the SSE
// `retry:` directive. Without it browsers default to ~3s, so after a server
// restart every client reconnects in lockstep every ~3s (thundering herd:
// each reconnect re-runs auth + pool acquire + DB queries). 5s widens the
// base; clients add their own jitter on top to de-correlate the herd.
export const SSE_RETRY_MS = 5000;

export interface SseResponseOptions<T> {
  // Returns the event's monotonic id (or undefined to skip the id line).
  extractId?: (item: T) => number | string | undefined;
  // Returns the JSON payload to serialize. Defaults to the item itself.
  extractData?: (item: T) => unknown;
}

export function sseResponse<T>(
  events: AsyncIterable<T>,
  opts: SseResponseOptions<T> = {},
): Response {
  const { extractId, extractData } = opts;
  const encoder = new TextEncoder();
  // Shared across start/cancel so a client disconnect can stop the heartbeat
  // and break the consuming loop promptly instead of waiting on `finally`.
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const abort = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // First frame: advertise the reconnect interval so a dropped
      // connection retries on our schedule rather than the browser default.
      controller.enqueue(encoder.encode(`retry: ${SSE_RETRY_MS}\n\n`));
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
        } catch {
          /* closed */
        }
      }, 15_000);
      (heartbeat as { unref?: () => void }).unref?.();
      try {
        for await (const item of events) {
          if (abort.signal.aborted) break;
          const id = extractId?.(item);
          const data = extractData ? extractData(item) : item;
          let frame = "";
          if (id !== undefined) frame += `id: ${id}\n`;
          frame += `data: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(frame));
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          const message = err instanceof Error ? err.message : String(err);
          // Tag the application-level error frame with a named event so
          // native EventSource clients can attach a dedicated
          // `stream_error` listener — `onerror` only fires for transport
          // failures, not app error frames over a healthy connection. The
          // `data` payload keeps its `type: 'error'` field for fetch-based
          // (`streamSse`) consumers that read the JSON body directly.
          controller.enqueue(
            encoder.encode(
              `event: stream_error\ndata: ${JSON.stringify({
                type: "error",
                code: "stream_failed",
                message,
              })}\n\n`,
            ),
          );
        }
      } finally {
        clearInterval(heartbeat);
        heartbeat = undefined;
        if (!abort.signal.aborted) controller.close();
      }
    },
    cancel() {
      clearInterval(heartbeat);
      heartbeat = undefined;
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
