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
	// UI-only marker: when true, `code`/`details` are advisory metadata for the
	// UI (they still ship in the serialized envelope / fullContent) and are NOT
	// rendered into the model-facing text — the `message` is the complete model
	// view. Used by tools that put everything the model needs into the message
	// (e.g. edit's "Did you mean" closest-match hint) while keeping the
	// structured payload for the client.
	detailsUiOnly?: boolean;
}

// Binary artifact returned alongside a successful tool result — e.g. an image
// that the model should see inline or a file blob. Mirrors the SDK's
// `ToolBinaryResult` so it can be forwarded verbatim to `binaryResultsForLlm`.
export interface ToolBinaryResult {
	data: string; // base64-encoded bytes
	mimeType: string;
	type: 'image' | 'resource';
	description?: string;
}

// A model-facing rendered view a tool may attach to a successful result. The
// tool renders its own output (rg-style Grep, Read (with optional line numbering), diff-after-Edit,
// raw Bash) as a typed array so the same views reach the model on every
// provider edge — the pi session forwards them verbatim as content blocks
// (text and image), the string edges join the text blocks.
// Mirrors the MCP/SDK content-block shape on purpose.
export type ToolResultView =
	| { type: 'text'; text: string }
	| { type: 'image'; data: string; mimeType: string; description?: string };

// The uniform envelope every PortalTool handler returns. Discriminated on `ok`:
// framework fields (`ok`/`summary`) live top-level so they never collide with a
// tool's own data, which nests under `result`. The envelope is the single
// provider-agnostic internal API: at each provider boundary it is projected
// (via `deriveToolResultViews`) into two views that derive from this one source
// — a concise, RAW text for the model and the full serialized payload for the
// UI — so the two can never silently diverge.
//
// The shape is intentionally open to additional optional top-level framework
// fields without restructuring. `followUpHint` is one such reserved framework
// field: an optional, model-visible nudge about a sensible next step that any
// successful tool may set (e.g. git_commit reminding the agent to reconcile
// workspace tickets). It lives only on the `ok: true` variant.
export type ToolResult =
	| {
			ok: true;
			summary?: string;
			result?: unknown;
			followUpHint?: string;
			binary?: ToolBinaryResult[];
			// Tool-provided rendered views, when the tool renders its own output
			// (rg-style Grep, Read (with optional line numbering), diff-after-Edit, raw Bash). A typed
			// array so one tool can carry multiple payloads — e.g. an image read
			// ships both the text summary and the image block the model must see.
			// Preferred over the generic projection in `deriveToolResultViews`, and
			// forwarded verbatim on the MCP edge so the same views reach the model
			// on every provider. Absent for tools whose output must stay byte-exact
			// in the raw envelope (edit, write).
			views?: ToolResultView[];
	  }
	| { ok: false; summary?: string; error: ToolError };

// A tool's declaration that its permission check should be evaluated as a
// filesystem request on a derived path instead of the default `custom-tool`
// request. The provider/permission layer substitutes `permissionKind` (e.g.
// `write`) and `path` so the request reuses the existing fs grants/seeds — an
// in-workspace `create_directory`, for instance, is covered by the standard
// session-workspace fs-write seed without needing a bespoke per-tool seed.
export interface ToolPermissionRequest {
	permissionKind: 'read' | 'write' | 'edit';
	// The derived filesystem target. Read by the scope-key derivation exactly
	// as a native fs request's `path` would be, so prefer an absolute,
	// symlink-resolved path so the matcher and the dialog agree on the target.
	path: string;
	// Additional fs targets that must ALSO be permitted for the same
	// invocation. The gateway evaluates `path` and every `additionalPaths`
	// entry against the user's grants + policy and combines the per-target
	// outcomes MOST-RESTRICTIVELY: a deny on any target denies the request, and
	// an auto-allow requires every target to be permitted. Used by two-path
	// tools like `move`, which must satisfy write on both source and
	// destination. A request with additional paths is never persistable from
	// the prompt (one stored scope can't capture multiple targets).
	additionalPaths?: string[];
}

export interface PortalTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	// Optional system-prompt contributions (pi `ToolDefinition` carries both).
	// Load-bearing usage/security caveats that must stay in-context live here
	// instead of bloating `description` (T31): `promptSnippet` is a one-line
	// "Available tools" entry; `promptGuidelines` are short guideline bullets.
	promptSnippet?: string;
	promptGuidelines?: string[];
	argsSchema?: z.ZodTypeAny;
	permissionBehavior?: 'normal' | 'always-prompt' | 'never-prompt';
	// Optional, pure (no IO) hook: when present and it returns a request, the
	// tool's permission is evaluated as that fs request rather than the default
	// `custom-tool` request. Returning null falls back to the custom-tool
	// request. It only inspects `args` to derive the target path.
	derivePermissionRequest?(args: unknown): ToolPermissionRequest | null;
	handler(args: unknown, ctx?: ToolStreamContext): Promise<ToolResult>;
}

// Build a resolver keyed by tool name that surfaces a tool's
// `derivePermissionRequest` hook to the shared permission gateway. Returns null
// for unknown tools or tools without the hook so the gateway proceeds with the
// default custom-tool request. Mirrors `buildToolArgsValidator`.
export function buildPermissionRequestResolver(
	tools: PortalTool[]
): (toolName: string, args: unknown) => ToolPermissionRequest | null {
	const byName = new Map<string, PortalTool>();
	for (const t of tools) byName.set(t.name, t);
	return (toolName, args) => {
		const tool = byName.get(toolName);
		if (!tool?.derivePermissionRequest) return null;
		return tool.derivePermissionRequest(args);
	};
}

// Build a success envelope. `result` is the tool's domain payload (any
// JSON-serializable value); `summary` is an optional short, human-readable line
// the provider prefers over its derived fallback. `opts.followUpHint` sets the
// reserved, model-visible next-step nudge. `opts.binary` attaches binary
// artifacts (images, blobs) to be forwarded to the model via the SDK's
// `binaryResultsForLlm` channel. `opts.views` attaches tool-rendered
// model-facing views (text and/or image) that win over the generic projection.
export function ok(
	result?: unknown,
	summary?: string,
	opts?: { followUpHint?: string; binary?: ToolBinaryResult[]; views?: ToolResultView[] }
): ToolResult {
	const envelope: ToolResult = { ok: true, result };
	if (summary !== undefined) envelope.summary = summary;
	if (opts?.followUpHint !== undefined) envelope.followUpHint = opts.followUpHint;
	if (opts?.binary !== undefined && opts.binary.length > 0) envelope.binary = opts.binary;
	if (opts?.views !== undefined && opts.views.length > 0) envelope.views = opts.views;
	return envelope;
}

// Build an error envelope. Handlers may return this directly instead of
// throwing; thrown exceptions are normalized to the same shape at the boundary.
export function err(
	message: string,
	opts?: { code?: string; details?: unknown; summary?: string; detailsUiOnly?: boolean }
): ToolResult {
	const error: ToolError = { message };
	if (opts?.code !== undefined) error.code = opts.code;
	if (opts?.details !== undefined) error.details = opts.details;
	if (opts?.detailsUiOnly !== undefined) error.detailsUiOnly = opts.detailsUiOnly;
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

// Parse a persisted/relayed serialized envelope JSON back into a typed
// `ToolResult`, preserving every framework field (`summary`, `followUpHint`,
// `error.code`/`details`). Returns null when the text isn't a portal envelope
// (e.g. a native SDK tool's `{ content, … }` shape) so callers can fall back.
// Used by both provider boundaries so a replayed/relayed result projects to the
// same model text a freshly produced one would.
export function parseEnvelopeJson(json: string): ToolResult | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const rec = parsed as Record<string, unknown>;
	if (typeof rec.ok !== 'boolean') return null;
	const summary = typeof rec.summary === 'string' ? rec.summary : undefined;
	if (rec.ok === false) {
		if (!rec.error || typeof rec.error !== 'object') return null;
		const e = rec.error as Record<string, unknown>;
		if (typeof e.message !== 'string') return null;
		const error: ToolError = { message: e.message };
		if (typeof e.code === 'string') error.code = e.code;
		if ('details' in e) error.details = e.details;
		if (e.detailsUiOnly === true) error.detailsUiOnly = true;
		return summary === undefined ? { ok: false, error } : { ok: false, summary, error };
	}
	const out: {
		ok: true;
		summary?: string;
		result?: unknown;
		followUpHint?: string;
		binary?: ToolBinaryResult[];
		views?: ToolResultView[];
	} = {
		ok: true,
		result: rec.result
	};
	if (summary !== undefined) out.summary = summary;
	if (typeof rec.followUpHint === 'string') out.followUpHint = rec.followUpHint;
	if (Array.isArray(rec.binary)) out.binary = rec.binary as ToolBinaryResult[];
	if (Array.isArray(rec.views)) out.views = rec.views as ToolResultView[];
	return out;
}

// The neutral, provider-agnostic projection of a `ToolResult` envelope into the
// two views every provider boundary needs. Both are derived from the SAME
// envelope by `deriveToolResultViews`, so a tool's model-facing text and its
// UI/timeline payload can never silently diverge. The field names are
// intentionally NEUTRAL (not SDK terms like `textResultForLlm`/`detailedContent`)
// — each adapter translates these into its provider's transport shape and must
// not invent its own projection.
export interface ToolResultViews {
	ok: boolean;
	// Collapsed single-line label for sidebar/timeline. Same value both edges show.
	summary: string;
	// Concise text handed to the model. RAW and unescaped (real newlines/tabs).
	// A tool's own rendering of its result (the text blocks of its `views`)
	// wins; otherwise a readable projection of the payload with any multi-line
	// string fields surfaced verbatim, falling back to the explicit `summary`
	// only when there is no meaningful payload. Never the JSON-escaped envelope,
	// and never the `summary` in place of an available payload.
	modelText: string;
	// Full payload for the UI: the canonical serialized envelope. The client
	// decodes this to render structured cards (git diffs, ticket/memory lists,
	// commit details, …) and falls back to its embedded raw text otherwise.
	fullContent: string;
}

// Canonical serialization of an envelope. This is the UI/timeline carrier
// (`fullContent`) — the client's `decodeToolResult` / `parseGitToolResult`
// decode exactly this shape — NOT the model-facing text.
export function serializeEnvelope(envelope: ToolResult): string {
	return JSON.stringify(envelope, null, 2);
}

// The one shared derive step both provider edges use to project an envelope
// into model text + UI payload. Centralizing it here is what keeps the two
// provider paths consistent and prevents the model/UI views from drifting.
export function deriveToolResultViews(envelope: ToolResult): ToolResultViews {
	return {
		ok: envelope.ok,
		summary: deriveEnvelopeSummary(envelope),
		modelText: deriveModelText(envelope),
		fullContent: serializeEnvelope(envelope)
	};
}

// Concise, raw text for the model. Errors render their message (plus code and
// any readable details). Successes prefer the tool's own rendered text — the
// `views` a tool attaches (rg-style Grep, Read (with optional line numbering), diff-after-Edit, raw
// Bash), joined across text blocks — and that text must reach the model
// identically on every provider edge. (Image views carry no model-facing text
// here; adapters forward them as image content blocks so the model sees them.)
// Otherwise render the PAYLOAD so multi-line string fields read as real text
// rather than JSON-escaped one-liners — the explicit `summary` is only a short
// headline for the UI/timeline (via `deriveEnvelopeSummary`), NOT a replacement
// for the payload: many tools pass a count-style summary (e.g. "5 result(s)")
// alongside the real result, so preferring it here would starve the model of
// the data it asked for. The summary is used only as a fallback when there is
// no meaningful payload, so the model never receives empty tool-message
// content. A reserved `followUpHint`, when present, is appended so the model
// still sees the next-step nudge it used to receive when the whole envelope
// was serialized verbatim to the model.
function deriveModelText(envelope: ToolResult): string {
	if (!envelope.ok) {
		const { message, code, details, detailsUiOnly } = envelope.error;
		let text = detailsUiOnly ? message : code ? `${message} (code: ${code})` : message;
		if (details !== undefined && !detailsUiOnly) text += `\n${renderReadable(details)}`;
		return text;
	}
	const rendered = renderViewText(envelope.views);
	const payload = rendered !== undefined ? rendered : derivePayloadText(envelope);
	return withFollowUpHint(payload, envelope.followUpHint);
}

// Concatenate a tool's rendered text views with blank-line separators, mirroring
// how MCP content blocks read back-to-back. Returns undefined when there are no
// text views (image-only results derive text from the payload).
function renderViewText(views: ToolResultView[] | undefined): string | undefined {
	const texts =
		views
			?.filter(
				(v): v is { type: 'text'; text: string } => v.type === 'text' && v.text.trim().length > 0
			)
			.map((v) => v.text) ?? [];
	if (texts.length === 0) return undefined;
	return texts.join('\n\n');
}

function derivePayloadText(envelope: { result?: unknown; summary?: string }): string {
	if (envelope.result !== undefined) {
		const text =
			typeof envelope.result === 'string' ? envelope.result : renderReadable(envelope.result);
		if (text.trim()) return text;
	}
	return envelope.summary?.trim() || '(no result)';
}

function withFollowUpHint(text: string, hint: string | undefined): string {
	const trimmed = hint?.trim();
	return trimmed ? `${text}\n\n${trimmed}` : text;
}

// Generic (no per-tool special-casing) readable renderer: a compact YAML-ish
// projection of a JSON value where multi-line string fields are printed
// verbatim (indented) instead of JSON-escaped. Used only for the model-facing
// text of object/array payloads; structured UI rendering uses `fullContent`.
function renderReadable(value: unknown): string {
	const lines: string[] = [];
	emitReadable(value, 0, lines);
	return lines.join('\n').replace(/\s+$/, '');
}

function scalarText(v: unknown): string | null {
	if (v === null) return 'null';
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	if (typeof v === 'string') return v.includes('\n') ? null : v;
	return null;
}

function emitReadable(value: unknown, depth: number, lines: string[]): void {
	const pad = '  '.repeat(depth);
	if (Array.isArray(value)) {
		if (value.length === 0) {
			lines.push(`${pad}(empty)`);
			return;
		}
		for (const item of value) {
			const scalar = scalarText(item);
			if (scalar !== null) {
				lines.push(`${pad}- ${scalar}`);
			} else if (typeof item === 'string') {
				const [first, ...rest] = item.split('\n');
				lines.push(`${pad}- ${first}`);
				for (const r of rest) lines.push(`${pad}  ${r}`);
			} else {
				const sub: string[] = [];
				emitReadable(item, 0, sub);
				const [first, ...rest] = sub;
				lines.push(`${pad}- ${first ?? ''}`);
				for (const r of rest) lines.push(`${pad}  ${r}`);
			}
		}
		return;
	}
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) {
			lines.push(`${pad}(empty)`);
			return;
		}
		for (const [k, v] of entries) {
			const scalar = scalarText(v);
			if (scalar !== null) {
				lines.push(`${pad}${k}: ${scalar}`);
			} else if (typeof v === 'string') {
				lines.push(`${pad}${k}:`);
				for (const r of v.split('\n')) lines.push(`${pad}  ${r}`);
			} else {
				lines.push(`${pad}${k}:`);
				emitReadable(v, depth + 1, lines);
			}
		}
		return;
	}
	lines.push(`${pad}${scalarText(value) ?? String(value)}`);
}
