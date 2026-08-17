import { error } from "@sveltejs/kit";

/**
 * Default human-readable messages for the small set of error codes we use.
 * Routes can still pass an override message when something more specific
 * is useful (e.g., the Zod field path).
 */
const DEFAULT_MESSAGES: Record<string, string> = {
  bad_request: "Bad request",
  unauthorized: "Unauthorized",
  forbidden: "Forbidden",
  bad_origin: "Bad origin",
  not_found: "Not found",
  conflict: "Conflict",
  unprocessable: "Unprocessable entity",
  rate_limited: "Too many requests",
  internal: "Internal server error",
};

/**
 * Throw a SvelteKit `error()` with a unified JSON body shape.
 *
 *   { message: string, code: string }
 *
 * Use this from `/api/*` route handlers so every rejection has the same
 * envelope. The hooks layer (`hooks.server.ts`) has its own equivalent
 * helper, `apiErrorResponse`, because hooks must build a `Response`
 * directly instead of throwing.
 */
export function apiError(
  status: number,
  code: string,
  message?: string,
): never {
  throw error(status, {
    message: message ?? DEFAULT_MESSAGES[code] ?? code,
    code,
  });
}

/**
 * Build a `Response` for the same `{message, code}` body, for callers
 * (notably `hooks.server.ts`) that can't throw `error()`.
 */
export function apiErrorResponse(
  status: number,
  code: string,
  message?: string,
): Response {
  return new Response(
    JSON.stringify({
      message: message ?? DEFAULT_MESSAGES[code] ?? code,
      code,
    }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

// --- Generic HTTP transport helpers (moved here from the deleted provider
// layer; used by the memory extractor's model-backed completion) ---

export interface SseEvent {
  event: string | null;
  data: string;
}

export async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    // Upstream proxies (502/429/503) often return HTML or plain text. Preserve
    // the real body in an error-shaped object so callers/logs keep the
    // actionable upstream message instead of `err: undefined`.
    return { error: { message: text.slice(0, 500) } };
  }
}

export function jsonRequestHeaders(apiKey?: string | null): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const timeout = new AbortController();
  const handle = setTimeout(() => {
    timeout.abort(
      new DOMException(
        `Request timed out after ${timeoutMs}ms.`,
        "TimeoutError",
      ),
    );
  }, timeoutMs);
  const { signal, releaseTimeout, cleanup } = combineAbortSignals(
    init.signal,
    timeout.signal,
  );
  try {
    return await fetch(input, { ...init, signal });
  } catch (error) {
    // fetch rejected (timeout, abort, or connection failure) — nothing is
    // streaming, so drop every listener.
    cleanup();
    throw error;
  } finally {
    // The timeout only guards the request up to the response headers; once
    // fetch resolves we stop the timer and drop its listener, but keep the
    // caller-signal → combined link so a later Stop during body streaming
    // still aborts the in-flight read. (combineAbortSignals self-cleans the
    // caller listener when it fires; cleanup() above handles the error path.)
    clearTimeout(handle);
    releaseTimeout();
  }
}

function combineAbortSignals(
  existing: AbortSignal | null | undefined,
  timeout: AbortSignal,
): { signal: AbortSignal; releaseTimeout: () => void; cleanup: () => void } {
  if (!existing)
    return {
      signal: timeout,
      releaseTimeout: () => undefined,
      cleanup: () => undefined,
    };
  const combined = new AbortController();
  const abortFromExisting = () => combined.abort(existing.reason);
  const abortFromTimeout = () => combined.abort(timeout.reason);
  if (existing.aborted) abortFromExisting();
  if (timeout.aborted) abortFromTimeout();
  existing.addEventListener("abort", abortFromExisting, { once: true });
  timeout.addEventListener("abort", abortFromTimeout, { once: true });
  return {
    signal: combined.signal,
    releaseTimeout: () => {
      timeout.removeEventListener("abort", abortFromTimeout);
    },
    cleanup: () => {
      existing.removeEventListener("abort", abortFromExisting);
      timeout.removeEventListener("abort", abortFromTimeout);
    },
  };
}

export async function* streamSseData(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  for await (const event of streamSseEvents(body)) {
    yield event.data;
  }
}

export async function* streamSseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | null = null;
  let dataLines: string[] = [];

  function drainLine(line: string): SseEvent | null {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed === "") {
      if (dataLines.length === 0) {
        eventName = null;
        return null;
      }
      const event = { event: eventName, data: dataLines.join("\n") };
      eventName = null;
      dataLines = [];
      return event;
    }
    if (trimmed.startsWith(":")) return null;
    const separator = trimmed.indexOf(":");
    const field = separator === -1 ? trimmed : trimmed.slice(0, separator);
    const value =
      separator === -1 ? "" : trimmed.slice(separator + 1).replace(/^ /, "");
    if (field === "event") eventName = value;
    if (field === "data") dataLines.push(value);
    return null;
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const event = drainLine(line);
        if (event) yield event;
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      const event = drainLine(buffer);
      if (event) yield event;
    }
    if (dataLines.length > 0)
      yield { event: eventName, data: dataLines.join("\n") };
  } finally {
    reader.releaseLock();
  }
}
