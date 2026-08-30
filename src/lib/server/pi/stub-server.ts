// In-process OpenAI-compatible stub model for the pi path, gated by `PI_STUB=1`.
// Lets e2e tests exercise the full turn-runner / SSE / persistence pipeline
// without real model credentials or network. The reply is deterministic
// (`Stubbed reply to: <last user message>`) so tests can assert on the literal
// prompt.
//
// The stub is a real `node:http` server on 127.0.0.1 (ephemeral port) registered
// into the pi `ModelRuntime` as an `openai-completions` provider, so the pi SDK
// drives it over actual HTTP — keeping the pi request path honest.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config";
import type { PiModel } from "./session";

const STUB_PROVIDER = "pi-stub";
const STUB_MODEL_ID = "stub-model";
const STUB_API_KEY = "pi-stub-key";

interface StubRequestBody {
  messages?: unknown[];
  model?: unknown;
  stream?: unknown;
}

let serverPromise: Promise<string> | null = null;
let stubRegistered = false;

// One-shot gate for the `@trigger-empty` directive: the FIRST request carrying
// a given last-user-text replies with NO content, then subsequent identical
// prompts (e.g. a Retry/regenerate of the same turn, which re-sends the same
// user message) get the normal reply. Keys are the full user text, which e2e
// tests make unique per test, so there's no cross-test state.
const emptyTriggered = new Set<string>();

// The most recent system-prompt string seen on any request. Lets e2e tests
// assert on what the model actually received (e.g. that an inline extension's
// `before_agent_start` guidance reached the system prompt). Set on every
// request, so a test reads this immediately after its own turn.
let lastSystemPrompt = "";

/** The system prompt of the most recent stub-model request ("" if none yet). */
export function getLastSystemPrompt(): string {
  return lastSystemPrompt;
}

/** Base URL of the shared stub server (started lazily, kept for process lifetime). */
export function getStubServerBaseUrl(): Promise<string> {
  serverPromise ??= startServer();
  return serverPromise;
}

export function isPiStubMode(): boolean {
  return loadConfig().PI_STUB;
}

/**
 * Register the stub model on the shared runtime and return it. Idempotent per
 * process: the provider is registered once, then reused.
 */
export async function getStubModel(
  runtime: ModelRuntime,
): Promise<PiModel | undefined> {
  if (!stubRegistered) {
    const baseUrl = await getStubServerBaseUrl();
    runtime.registerProvider(STUB_PROVIDER, {
      name: "pi stub",
      api: "openai-completions",
      baseUrl,
      apiKey: STUB_API_KEY,
      authHeader: true,
      models: [
        {
          id: STUB_MODEL_ID,
          name: "Pi Stub Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 4096,
        },
      ],
    });
    stubRegistered = true;
  }
  return runtime.getModel(STUB_PROVIDER, STUB_MODEL_ID);
}

function startServer(): Promise<string> {
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("stub error");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}/v1`);
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  const body = (await readJsonBody(req).catch(
    () => null,
  )) as StubRequestBody | null;
  if (!body || !Array.isArray(body.messages)) {
    res.statusCode = 400;
    res.end("bad request");
    return;
  }
  // Capture the system prompt (inline string or first `system` message) so
  // tests can assert on what the loaded extensions injected.
  const inlineSystem = (body as { system?: unknown }).system;
  const sysMsg = [...body.messages]
    .reverse()
    .find(
      (m) =>
        !!m &&
        typeof m === "object" &&
        (m as { role?: unknown }).role === "system",
    ) as { content?: unknown } | undefined;
  lastSystemPrompt =
    typeof inlineSystem === "string"
      ? inlineSystem
      : typeof sysMsg?.content === "string"
        ? sysMsg.content
        : "";
  const userText = lastUserText(body.messages);
  // Stateless termination guard: once the model has emitted a tool call, the
  // follow-up request (assistant tool_calls + tool result in history) replies
  // with plain text — the directive isn't re-triggered, so the loop ends.
  const sequence = parseToolSequenceDirective(userText);
  const completedToolCalls = countAssistantToolCalls(body.messages);
  const procToolCall = parseProcWorkerDirective(userText, completedToolCalls);
  const toolCall =
    procToolCall ??
    (sequence
      ? (sequence[completedToolCalls] ?? null)
      : completedToolCalls > 0
        ? null
        : parseToolCallDirective(userText));
  // `@trigger-empty` makes the FIRST request carrying this exact user text
  // reply with NO content (a silently-empty response), so e2e can exercise
  // the empty-turn handling. One-shot per unique prompt: a Retry/regenerate
  // of the same turn (which re-sends the identical user message) gets the
  // normal reply, letting tests assert "empty → visible error → Retry
  // succeeds" deterministically.
  const emptyReply =
    userText.includes("@trigger-empty") && !emptyTriggered.has(userText);
  if (emptyReply) emptyTriggered.add(userText);
  const reply = emptyReply ? "" : `Stubbed reply to: ${userText}`;
  const id = `chatcmpl-stub-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = typeof body.model === "string" ? body.model : STUB_MODEL_ID;

  if (toolCall) {
    if (procToolCall && userText.includes("@trigger-slow-proc")) {
      await new Promise((resolve) =>
        setTimeout(resolve, SLOW_PROC_TOOL_CALL_HOLD_MS),
      );
    }
    if (body.stream === true) {
      writeSseToolCallReply(res, { id, created, model, ...toolCall });
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `call-stub-${Date.now()}`,
                    type: "function",
                    function: { name: toolCall.name, arguments: toolCall.args },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    }
    return;
  }

  if (body.stream === true) {
    writeSseReply(res, {
      id,
      created,
      model,
      reply,
      slowStart: userText.includes("@trigger-slow-start"),
      slowStream: userText.includes("@trigger-slow-stream"),
    });
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: reply },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  }
}

// Stream the reply as OpenAI chat-completions SSE chunks so pi's
// openai-completions provider parses real stream deltas (not one blob).
const SLOW_START_HOLD_MS = 1200;
const SLOW_PROC_TOOL_CALL_HOLD_MS = 3000;
const SLOW_STREAM_INTERVAL_MS = 120;
function writeSseReply(
  res: ServerResponse,
  opts: {
    id: string;
    created: number;
    model: string;
    reply: string;
    slowStart?: boolean;
    slowStream?: boolean;
  },
): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunks = opts.reply.match(/.{1,16}/g) ?? [opts.reply];
  const finishIndex = chunks.length - 1;
  const chunkEvent = (delta: string, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: opts.id,
      object: "chat.completion.chunk",
      created: opts.created,
      model: opts.model,
      choices: [
        {
          index: 0,
          delta: delta ? { content: delta } : {},
          finish_reason: finishReason,
        },
      ],
    })}\n\n`;
  // `@trigger-slow-start` in the prompt holds the first byte so the turn sits
  // in the pre-delta "setting up" state long enough to assert on; otherwise the
  // first chunk goes out immediately and the rest drain on a short timer
  // (mirrors a real model's token cadence). `@trigger-slow-stream` widens the
  // inter-chunk gap so e2e can observe intermediate (partially-streamed) text
  // in the UI instead of only the finished reply.
  const intervalMs = opts.slowStream ? SLOW_STREAM_INTERVAL_MS : 2;
  const emit = () => {
    for (let i = 0; i <= finishIndex; i++) {
      if (i === 0) {
        res.write(chunkEvent(chunks[0], finishIndex === 0 ? "stop" : null));
        continue;
      }
      setTimeout(() => {
        if (i === finishIndex) res.write(chunkEvent(chunks[i], "stop"));
        else res.write(chunkEvent(chunks[i], null));
      }, i * intervalMs);
    }
    res.write(
      `data: ${JSON.stringify({
        id: opts.id,
        object: "chat.completion.chunk",
        created: opts.created,
        model: opts.model,
        choices: [],
      })}\n\n`,
    );
    setTimeout(
      () => {
        res.write("data: [DONE]\n\n");
        res.end();
      },
      (finishIndex + 1) * intervalMs,
    );
  };
  if (opts.slowStart) setTimeout(emit, SLOW_START_HOLD_MS);
  else emit();
}

// `PI_TEST_TOOLCALL <toolName> <jsonArgs>` as the entire user prompt makes the
// model emit a single tool call with those args — lets e2e tests drive the
// permission gate without a real model.
const TOOLCALL_RE = /^PI_TEST_TOOLCALL\s+([A-Za-z0-9_.-]+)\s+(\{[\s\S]*\})\s*$/;
function parseToolCallDirective(
  text: string,
): { name: string; args: string } | null {
  const m = TOOLCALL_RE.exec(text);
  if (!m) return null;
  return { name: m[1], args: m[2] };
}

const TOOL_SEQUENCE_RE = /^PI_TEST_TOOL_SEQUENCE\s+(\[[\s\S]*\])\s*$/;

function parseToolSequenceDirective(
  text: string,
): Array<{ name: string; args: string }> | null {
  const match = TOOL_SEQUENCE_RE.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const sequence: Array<{ name: string; args: string }> = [];
    for (const entry of parsed) {
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof (entry as { name?: unknown }).name !== "string" ||
        !("args" in entry)
      ) {
        return null;
      }
      sequence.push({
        name: (entry as { name: string }).name,
        args: JSON.stringify((entry as { args: unknown }).args),
      });
    }
    return sequence;
  } catch {
    return null;
  }
}

function parseProcWorkerDirective(
  userText: string,
  completedToolCalls: number,
): { name: string; args: string } | null {
  let procedure: string;
  try {
    const request = JSON.parse(userText) as { procedure?: unknown };
    if (typeof request.procedure !== "string") return null;
    procedure = request.procedure;
  } catch {
    const match = userText.match(
      /(?:^|\n)Instructions\n([\s\S]*?)\n\nResult requirements(?:\n|$)/,
    );
    if (!match) return null;
    procedure = match[1];
  }
  const marker = "PI_TEST_PROC_RETURN ";
  const markerIndex = procedure.indexOf(marker);
  if (markerIndex < 0) return null;
  if (completedToolCalls === 0) {
    const raw = procedure.slice(markerIndex + marker.length).trim();
    try {
      const value = JSON.parse(raw) as unknown;
      return {
        name: "finish",
        args: JSON.stringify({
          javascript: `return ${JSON.stringify(value)};`,
        }),
      };
    } catch {
      return null;
    }
  }
  return null;
}

function countAssistantToolCalls(messages: unknown[]): number {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      !!message &&
      typeof message === "object" &&
      (message as { role?: unknown }).role === "user"
    ) {
      lastUserIndex = index;
      break;
    }
  }
  return messages.slice(lastUserIndex + 1).reduce<number>((total, message) => {
    if (
      !message ||
      typeof message !== "object" ||
      (message as { role?: unknown }).role !== "assistant"
    ) {
      return total;
    }
    const calls = (message as { tool_calls?: unknown }).tool_calls;
    return total + (Array.isArray(calls) ? calls.length : 0);
  }, 0);
}

// Stream an OpenAI-style tool_calls delta sequence (name chunk, then the JSON
// arguments chunk, then finish) so pi's openai-completions provider assembles
// the call from real stream deltas.
function writeSseToolCallReply(
  res: ServerResponse,
  opts: {
    id: string;
    created: number;
    model: string;
    name: string;
    args: string;
  },
): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: opts.id,
      object: "chat.completion.chunk",
      created: opts.created,
      model: opts.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  const tcId = `call-stub-${Date.now()}`;
  res.write(
    chunk(
      {
        tool_calls: [
          {
            index: 0,
            id: tcId,
            type: "function",
            function: { name: opts.name },
          },
        ],
      },
      null,
    ),
  );
  res.write(
    chunk(
      { tool_calls: [{ index: 0, function: { arguments: opts.args } }] },
      null,
    ),
  );
  res.write(chunk({}, "tool_calls"));
  setTimeout(() => {
    res.write("data: [DONE]\n\n");
    res.end();
  }, 10);
}

function lastUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== "user") continue;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .map((part) =>
          part &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string"
            ? ((part as { text: string }).text as string)
            : "",
        )
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "(no user message)";
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("stub body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
