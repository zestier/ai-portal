import type { z } from 'zod';

// Optional, opt-in streaming channel handed to a PortalTool handler so it can
// surface incremental feedback while it runs. Both methods reuse the existing
// ephemeral streaming events (`tool.partial_output` / `tool.progress`) and are
// no-ops once the turn is aborted. Handlers that don't need streaming simply
// ignore `ctx`.
export interface ToolStreamContext {
	// Cumulative stdout/stderr snapshot. The client REPLACES (not appends) on each
	// call, mirroring `tool.partial_output` semantics.
	partial(output: string): void;
	// Short human-readable status line.
	progress(message: string): void;
	// Mirrors the turn's abort signal.
	readonly signal: AbortSignal;
}

// Structured error payload nested under the `ok: false` variant of a
// `ToolResult`. `message` is always present; `code`/`details` are optional and
// purely advisory for the model.
export interface ToolError {
	message: string;
	code?: string;
	details?: unknown;
}

// The uniform envelope every PortalTool handler returns. Discriminated on `ok`:
// framework fields (`ok`/`summary`) live top-level so they never collide with a
// tool's own data, which nests under `result`. The whole envelope is serialized
// exactly once at the provider boundary and is the single payload the model
// sees AND the UI deserializes — there is no hidden, model-invisible data.
//
// The shape is intentionally open to additional optional top-level framework
// fields (e.g. a future `followUpHint`) without restructuring.
export type ToolResult =
	| { ok: true; summary?: string; result?: unknown }
	| { ok: false; summary?: string; error: ToolError };

export interface PortalTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	argsSchema?: z.ZodTypeAny;
	permissionBehavior?: 'normal' | 'always-prompt' | 'never-prompt';
	handler(args: unknown, ctx?: ToolStreamContext): Promise<ToolResult>;
}

// Build a success envelope. `result` is the tool's domain payload (any
// JSON-serializable value); `summary` is an optional short, human-readable line
// the provider prefers over its derived fallback.
export function ok(result?: unknown, summary?: string): ToolResult {
	return summary === undefined ? { ok: true, result } : { ok: true, result, summary };
}

// Build an error envelope. Handlers may return this directly instead of
// throwing; thrown exceptions are normalized to the same shape at the boundary.
export function err(
	message: string,
	opts?: { code?: string; details?: unknown; summary?: string }
): ToolResult {
	const error: ToolError = { message };
	if (opts?.code !== undefined) error.code = opts.code;
	if (opts?.details !== undefined) error.details = opts.details;
	return opts?.summary === undefined
		? { ok: false, error }
		: { ok: false, summary: opts.summary, error };
}

// Human-meaningful text extracted from an envelope: the error message for
// failures, the raw string or compact JSON of `result` for successes. Used as
// the basis for the derived collapsed-line summary when no explicit `summary`
// was supplied.
export function envelopePayloadText(envelope: ToolResult): string {
	if (!envelope.ok) return envelope.error.message;
	if (envelope.result === undefined) return '';
	return typeof envelope.result === 'string' ? envelope.result : JSON.stringify(envelope.result);
}

// The single source of truth for an envelope's collapsed-line summary, shared by
// every provider boundary so the same tool yields identical text regardless of
// which runtime executed it. Prefers an explicit `summary`; otherwise derives a
// single-line, length-capped snippet from the payload.
export function deriveEnvelopeSummary(envelope: ToolResult): string {
	const explicit = envelope.summary?.trim();
	if (explicit) return explicit;
	const singleLine = envelopePayloadText(envelope).replace(/\s+/g, ' ').trim();
	if (!singleLine) return '(empty result)';
	return singleLine.length > 200 ? `${singleLine.slice(0, 197)}...` : singleLine;
}
