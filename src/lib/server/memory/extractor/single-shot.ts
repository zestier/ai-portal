/**
 * The single-shot JSON memory extractor: one model call that returns the whole
 * patch as structured JSON (response_format json_schema), plus the envelope/JSON
 * parsing it needs. A separate path from the agentic tool-calling extractor;
 * kept programmatic-only (constructed directly, not env-selectable) so its
 * parsing logic stays covered without a second config surface.
 *
 * The completion runs over the shared pi `ModelRuntime` via
 * `piCompleteSimple`; the model is a `providerId/modelId` selection.
 */
import {
  coerceMemoryPatchInput,
  MEMORY_PATCH_JSON_SCHEMA,
  MemoryPatchProposalSchema,
} from "../engine";
import {
  resolveModelSelection,
  piCompleteSimple,
} from "$lib/server/pi/complete";
import { sanitizePatch } from "./sanitize";
import { buildExtractorPrompt } from "./prompts";
import { log } from "$lib/server/log";
import type {
  ExtractPatchInput,
  ExtractPatchResult,
  Diagnostic,
  MemoryExtractor,
} from "./types";

interface OpenAICompatibleExtractorOptions {
  modelSelection: string;
  timeoutMs: number;
  maxInputChars: number;
  completeJson?: ((prompt: string) => Promise<unknown>) | undefined;
}

// JSON Schema mirroring the model envelope ({ patch, summary, confidence,
// diagnostics }) and MemoryPatchProposalSchema. Sent via
// `response_format: { type: 'json_schema' }` so backends that reject the
// legacy `json_object` type still emit structured output. Kept
// non-strict (no `additionalProperties: false` / all-required) so the model
// can omit optional sections; the Zod parse afterward remains the source of
// truth.
const MEMORY_EXTRACTOR_JSON_SCHEMA = {
  name: "memory_patch",
  strict: false,
  schema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      diagnostics: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["info", "warning", "error"] },
            code: { type: "string" },
            message: { type: "string" },
          },
          required: ["code", "message"],
        },
      },
      patch: MEMORY_PATCH_JSON_SCHEMA,
    },
    required: ["patch"],
  },
} as const;

const SINGLE_SHOT_SYSTEM_PROMPT =
  "Extract durable memory as strict JSON only. Do not include prose outside JSON.";

export class OpenAICompatibleMemoryExtractor implements MemoryExtractor {
  readonly kind = "openai-compatible";
  readonly model: string;
  private readonly opts: OpenAICompatibleExtractorOptions;

  constructor(opts: OpenAICompatibleExtractorOptions) {
    this.opts = opts;
    this.model = opts.modelSelection;
  }

  async extractPatch(input: ExtractPatchInput): Promise<ExtractPatchResult> {
    const prompt = buildExtractorPrompt(input, this.opts.maxInputChars);
    const raw = this.opts.completeJson
      ? await this.opts.completeJson(prompt)
      : await requestModelCompletion(this.opts, prompt, input.signal);
    const parsed = parseModelPatch(raw);
    const diagnostics: Diagnostic[] = [...parsed.diagnostics];
    const sanitized = sanitizePatch(parsed.patch, input.initialPacket);
    diagnostics.push(...sanitized.diagnostics);
    return {
      patch: sanitized.patch,
      confidence: parsed.confidence,
      summary: parsed.summary,
      diagnostics,
      rawModelOutput: raw,
    };
  }
}

async function requestModelCompletion(
  opts: OpenAICompatibleExtractorOptions,
  prompt: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const { model, runtime } = await resolveModelSelection(opts.modelSelection);
  return piCompleteSimple({
    model,
    runtime,
    system: SINGLE_SHOT_SYSTEM_PROMPT,
    user: prompt,
    timeoutMs: opts.timeoutMs,
    ...(signal !== undefined ? { signal } : {}),
    responseSchema: MEMORY_EXTRACTOR_JSON_SCHEMA,
  });
}

interface ModelEnvelope {
  patch?: unknown;
  summary?: unknown;
  confidence?: unknown;
  diagnostics?: unknown;
}

function parseModelPatch(raw: unknown): ExtractPatchResult {
  const envelope = parseEnvelope(raw);
  const coerced = coerceMemoryPatchInput(envelope.patch ?? {});
  const parsed = MemoryPatchProposalSchema.safeParse(coerced.patch);
  const diagnostics: Diagnostic[] = [];
  for (const warning of coerced.warnings) {
    diagnostics.push({
      severity: "info",
      code: "model_patch_auto_repaired",
      message: warning,
    });
  }
  if (!parsed.success) {
    diagnostics.push({
      severity: "error",
      code: "model_patch_schema_invalid",
      message: parsed.error.issues.map((issue) => issue.message).join("; "),
    });
    return {
      patch: {},
      confidence: 0,
      summary: "Model-backed memory extraction produced invalid JSON.",
      diagnostics,
      rawModelOutput: raw,
    };
  }
  for (const diagnostic of Array.isArray(envelope.diagnostics)
    ? envelope.diagnostics
    : []) {
    const normalized = normalizeDiagnostic(diagnostic);
    if (normalized) diagnostics.push(normalized);
  }
  return {
    patch: parsed.data,
    confidence:
      typeof envelope.confidence === "number" ? envelope.confidence : 0.75,
    summary:
      typeof envelope.summary === "string"
        ? envelope.summary
        : "Model-backed memory extraction completed.",
    diagnostics,
    rawModelOutput: raw,
  };
}

function parseEnvelope(raw: unknown): ModelEnvelope {
  if (typeof raw === "string") {
    const json = extractJsonObject(raw);
    if (!json) return {};
    try {
      return JSON.parse(json) as ModelEnvelope;
    } catch (error) {
      log.warn("memory.extractor.single_shot_json_parse_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }
  if (raw && typeof raw === "object") {
    return raw as ModelEnvelope;
  }
  return {};
}

function normalizeDiagnostic(value: unknown): Diagnostic | null {
  if (!value || typeof value !== "object") return null;
  const row = value as {
    severity?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const severity =
    row.severity === "error" ||
    row.severity === "warning" ||
    row.severity === "info"
      ? row.severity
      : "info";
  if (typeof row.code !== "string" || typeof row.message !== "string")
    return null;
  return {
    severity,
    code: row.code.slice(0, 100),
    message: row.message.slice(0, 1000),
  };
}

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  if (start === -1) return null;
  // Depth-counting scan from the first `{` to its matching `}`, so trailing
  // prose after the JSON object (e.g. `{...} Let me know if...`) is ignored.
  // Track string state and escapes so braces inside string values don't count.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const char = candidate[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}
