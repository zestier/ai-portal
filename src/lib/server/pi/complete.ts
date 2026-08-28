/**
 * Shared completion seam for the background model consumers: the tool-calling
 * memory extractor and the adversary shadow reviewer. Both used to speak raw
 * HTTP to an OpenAI-compatible endpoint (T2 deleted that provider layer); both
 * now resolve a `providerId/modelId` selection against the shared pi
 * `ModelRuntime` and complete through it.
 *
 * `piChat` drives the extractor's agentic loop over `runtime.stream` (tool
 * calls, streamed reasoning/content). `piCompleteSimple` runs the one-shot
 * extractor and the reviewer as a single non-streaming completion. Both throw
 * `ModelCompletionError`, which carries the selection so failure logs can keep
 * attributing the call.
 */

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getModelRuntime } from "./index";
import { getStubModel, isPiStubMode } from "./stub-server";
import type {
  ExtractorChatMessage,
  ExtractorToolSpec,
  ExtractorAssistantTurn,
  ExtractorStreamDelta,
} from "../memory/extractor/types";

type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
type PiContext = Parameters<ModelRuntime["stream"]>[1];
type PiStream = ReturnType<ModelRuntime["stream"]>;
type PiAssistantMessage = Awaited<ReturnType<ModelRuntime["complete"]>>;
type PiMessage = PiContext["messages"][number];

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A background model completion failed, carrying the offending selection. */
export class ModelCompletionError extends Error {
  readonly model: string;

  constructor(model: string, message: string) {
    super(message);
    this.name = "ModelCompletionError";
    this.model = model;
  }
}

/**
 * Resolve a `providerId/modelId` selection against the shared runtime. The
 * stub provider is registered on demand in stub mode; otherwise the selection
 * must name a model in the runtime's catalog.
 */
export async function resolveModelSelection(
  selection: string,
): Promise<{ model: PiModel; runtime: ModelRuntime }> {
  const runtime = await getModelRuntime();
  if (selection.startsWith("pi-stub/") && isPiStubMode()) {
    const stub = await getStubModel(runtime);
    if (stub) return { model: stub, runtime };
  }
  const slash = selection.indexOf("/");
  if (slash <= 0) {
    throw new ModelCompletionError(
      selection,
      `invalid model selection "${selection}": expected "providerId/modelId"`,
    );
  }
  const model = runtime.getModel(
    selection.slice(0, slash),
    selection.slice(slash + 1),
  );
  if (!model) {
    throw new ModelCompletionError(
      selection,
      `pi model not found: ${selection}`,
    );
  }
  return { model, runtime };
}

export interface PiChatOptions {
  model: PiModel;
  runtime: ModelRuntime;
  timeoutMs: number;
  maxTokens?: number | undefined;
  toolChoice?: "auto" | "required" | undefined;
}

/**
 * One tool-calling step of the extractor loop: stream the model over the pi
 * runtime, surfacing reasoning/content deltas and returning the assembled
 * assistant turn (text + parsed tool calls). Mirrors the old
 * `requestOpenAICompatibleChat` contract so the loop body is unchanged.
 */
export async function piChat(
  opts: PiChatOptions,
  messages: ExtractorChatMessage[],
  tools: ExtractorToolSpec[],
  onDelta?: (delta: ExtractorStreamDelta) => void,
  signal?: AbortSignal,
  toolChoice?: "auto" | "required",
): Promise<ExtractorAssistantTurn> {
  const stream = opts.runtime.stream(
    opts.model,
    buildContext(opts.model, messages, tools),
    {
      temperature: 0,
      timeoutMs: opts.timeoutMs,
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      toolChoice: toolChoice ?? opts.toolChoice ?? "auto",
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  return assistantTurnOf(await consumeStream(opts.model, stream, onDelta));
}

export interface PiCompleteOptions {
  model: PiModel;
  runtime: ModelRuntime;
  system: string;
  user: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  responseSchema?: { name: string; schema: unknown } | undefined;
}

/** One non-streaming completion (`runtime.completeSimple`), text only. */
export async function piCompleteSimple(
  opts: PiCompleteOptions,
): Promise<string> {
  const message = await opts.runtime.completeSimple(
    opts.model,
    {
      systemPrompt: opts.system,
      messages: [{ role: "user", content: opts.user, timestamp: Date.now() }],
    },
    {
      temperature: 0,
      timeoutMs: opts.timeoutMs,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.responseSchema !== undefined
        ? {
            samplingParams: {
              response_format: {
                type: "json_schema",
                json_schema: opts.responseSchema,
              },
            },
          }
        : {}),
    },
  );
  return message.content
    .filter(
      (block): block is Extract<typeof block, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
}

/** Resolve a selection and complete against it — the reviewer's transport. */
export async function completeSimpleSelection(
  selection: string,
  req: {
    system: string;
    user: string;
    responseSchema?: { name: string; schema: unknown } | undefined;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
  },
): Promise<string> {
  const { model, runtime } = await resolveModelSelection(selection);
  return piCompleteSimple({
    model,
    runtime,
    system: req.system,
    user: req.user,
    timeoutMs: req.timeoutMs,
    ...(req.signal !== undefined ? { signal: req.signal } : {}),
    ...(req.responseSchema !== undefined
      ? { responseSchema: req.responseSchema }
      : {}),
  });
}

function buildContext(
  model: PiModel,
  messages: ExtractorChatMessage[],
  tools: ExtractorToolSpec[],
): PiContext {
  const systemText = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content ?? "")
    .join("\n\n");
  const context: PiContext = {
    messages: messages
      .filter((message) => message.role !== "system")
      .map((message) => toPiMessage(model, message)),
  };
  if (systemText) context.systemPrompt = systemText;
  if (tools.length > 0) context.tools = tools.map(toPiTool);
  return context;
}

function toPiTool(
  spec: ExtractorToolSpec,
): NonNullable<PiContext["tools"]>[number] {
  return {
    name: spec.function.name,
    description: spec.function.description,
    parameters: spec.function.parameters as unknown as NonNullable<
      PiContext["tools"]
    >[number]["parameters"],
  };
}

function toPiMessage(model: PiModel, msg: ExtractorChatMessage): PiMessage {
  const timestamp = Date.now();
  switch (msg.role) {
    case "user":
      return { role: "user", content: msg.content ?? "", timestamp };
    case "assistant": {
      const toolCalls = (msg.tool_calls ?? []).map((call) => ({
        type: "toolCall" as const,
        id: call.id,
        name: call.function.name,
        arguments: parseToolCallArguments(call.function.arguments),
      }));
      return {
        role: "assistant",
        content: [
          ...(msg.content
            ? [{ type: "text" as const, text: msg.content }]
            : []),
          ...toolCalls,
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: ZERO_USAGE,
        stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
        timestamp,
      };
    }
    case "tool":
      return {
        role: "toolResult",
        toolCallId: msg.tool_call_id ?? "",
        toolName: "",
        content: [{ type: "text", text: msg.content ?? "" }],
        isError: false,
        timestamp,
      };
    default:
      // System messages are hoisted into `context.systemPrompt` by
      // `buildContext`, so they never reach this mapper.
      throw new Error(`unexpected message role: ${msg.role}`);
  }
}

function parseToolCallArguments(raw: string): Record<string, unknown> {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Malformed arguments from a weak model: pi's contract requires an
    // object, so degrade to `{}`. The write-tool validation feedback on the
    // empty args then nudges the model to re-issue the call correctly.
    return {};
  }
}

async function consumeStream(
  model: PiModel,
  stream: PiStream,
  onDelta?: (delta: ExtractorStreamDelta) => void,
): Promise<PiAssistantMessage> {
  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        onDelta?.({ content: event.delta });
        break;
      case "thinking_delta":
        onDelta?.({ reasoning: event.delta });
        break;
      case "done":
        return event.message;
      case "error":
        if (event.reason === "aborted") {
          // Keep the caller's abort contract: extraction is cancelled, not
          // failed, so the turn runner treats it as a user stop.
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        throw new ModelCompletionError(
          modelSelectionOf(model),
          event.error.errorMessage ??
            `model completion failed (${event.reason})`,
        );
    }
  }
  throw new ModelCompletionError(
    modelSelectionOf(model),
    "model stream ended without a final message",
  );
}

function assistantTurnOf(message: PiAssistantMessage): ExtractorAssistantTurn {
  const content: string[] = [];
  const toolCalls: ExtractorAssistantTurn["toolCalls"] = [];
  let reasoning: string | undefined;
  for (const block of message.content) {
    if (block.type === "text") content.push(block.text);
    else if (block.type === "thinking") {
      reasoning =
        reasoning === undefined
          ? block.thinking
          : `${reasoning}\n${block.thinking}`;
    } else if (block.type === "toolCall") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.arguments),
      });
    }
  }
  return {
    content: content.join(""),
    toolCalls,
    ...(reasoning !== undefined ? { reasoning } : {}),
    usage: {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      cost: message.usage.cost.total,
    },
  };
}

function modelSelectionOf(model: PiModel): string {
  return `${model.provider}/${model.id}`;
}
