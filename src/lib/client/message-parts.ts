import type { ToolCallRecord } from '$lib/types';
import type {
	DisplayFileEdit,
	DisplayReasoningBlock,
	DisplayMessage
} from '$lib/client/display-message';

export type Part =
	| { kind: 'text'; html: string }
	| { kind: 'tool'; tool: ToolCallRecord }
	| { kind: 'edit'; edit: DisplayFileEdit }
	| { kind: 'reasoning'; block: DisplayReasoningBlock; streaming: boolean };

export interface BuildPartsInput {
	role: DisplayMessage['role'];
	status: DisplayMessage['status'];
	content: string;
	toolCalls: ToolCallRecord[] | null | undefined;
	fileEdits: DisplayFileEdit[] | null | undefined;
	reasoningBlocks: DisplayReasoningBlock[] | null | undefined;
	renderMarkdown: (text: string) => string;
}

/**
 * Derive the ordered render parts for an assistant message: interleaved text,
 * tool calls, file edits, and reasoning segments, anchored by their stream
 * offsets. Pure — the component calls this from a `$derived` so the markup only
 * sees the final Part list.
 */
export function buildParts(input: BuildPartsInput): Part[] {
	const { role, status, content, toolCalls, fileEdits, reasoningBlocks, renderMarkdown } = input;
	if (role !== 'assistant') return [];
	// Filter out children of sub-agent task calls — they belong inside
	// the outer SubagentCall card, not at the message level.
	const tools = (toolCalls ?? []).filter((t) => t.parentToolCallId == null);
	const edits = (fileEdits ?? []).filter((e) => e.parentToolCallId == null);
	const reasoning = (reasoningBlocks ?? []).filter((r) => r.parentToolCallId == null);

	// Only the latest still-open block on a streaming message ticks the
	// "Thinking… Xs" header. A reasoning block is "open" until its
	// durationMs is set (by message.reasoning.end at the bridge boundary).
	// Anything earlier shows its final "Thought for Xs".
	const streaming = role === 'assistant' && status === 'streaming';
	let latestOpenSegmentIdx = -1;
	if (streaming) {
		for (const r of reasoning) {
			if (r.durationMs == null && r.segmentIndex > latestOpenSegmentIdx) {
				latestOpenSegmentIdx = r.segmentIndex;
			}
		}
	}

	// Anything without an explicit offset is rendered after all text
	// (legacy rows persisted before interleaving was tracked).
	const trailingTools: ToolCallRecord[] = [];
	const trailingEdits: DisplayFileEdit[] = [];
	const trailingReasoning: DisplayReasoningBlock[] = [];

	type Anchor =
		| { offset: number; ts: number; kind: 'tool'; tool: ToolCallRecord }
		| { offset: number; ts: number; kind: 'edit'; edit: DisplayFileEdit }
		| {
				offset: number;
				ts: number;
				kind: 'reasoning';
				block: DisplayReasoningBlock;
		  };
	const anchors: Anchor[] = [];
	// Sort tiebreaker at the same textOffset is the wall-clock timestamp
	// captured at stream time (reasoning.startedAt, tool.startedAt,
	// edit.createdAt). Reasoning bursts and the tool they precede share
	// an offset (no visible text between them); using a real temporal
	// tiebreaker keeps the rendered order matching the actual stream
	// order — reason → tool → reason → tool — instead of bunching all
	// reasoning above all tools.
	for (const r of reasoning) {
		if (r.textOffset == null) trailingReasoning.push(r);
		else
			anchors.push({
				offset: Math.min(r.textOffset, content.length),
				ts: r.startedAt,
				kind: 'reasoning',
				block: r
			});
	}
	for (const t of tools) {
		if (t.textOffset == null) trailingTools.push(t);
		else
			anchors.push({
				offset: Math.min(t.textOffset, content.length),
				ts: t.startedAt,
				kind: 'tool',
				tool: t
			});
	}
	for (const e of edits) {
		if (e.textOffset == null) trailingEdits.push(e);
		else
			anchors.push({
				offset: Math.min(e.textOffset, content.length),
				ts: e.createdAt,
				kind: 'edit',
				edit: e
			});
	}
	anchors.sort((a, b) => a.offset - b.offset || a.ts - b.ts);

	const out: Part[] = [];
	let cursor = 0;
	for (const a of anchors) {
		if (a.offset > cursor) {
			out.push({ kind: 'text', html: renderMarkdown(content.slice(cursor, a.offset)) });
			cursor = a.offset;
		}
		if (a.kind === 'tool') out.push({ kind: 'tool', tool: a.tool });
		else if (a.kind === 'edit') out.push({ kind: 'edit', edit: a.edit });
		else
			out.push({
				kind: 'reasoning',
				block: a.block,
				streaming: a.block.segmentIndex === latestOpenSegmentIdx
			});
	}
	if (cursor < content.length) {
		out.push({ kind: 'text', html: renderMarkdown(content.slice(cursor)) });
	}
	for (const r of trailingReasoning) {
		out.push({
			kind: 'reasoning',
			block: r,
			streaming: r.segmentIndex === latestOpenSegmentIdx
		});
	}
	for (const t of trailingTools) out.push({ kind: 'tool', tool: t });
	for (const e of trailingEdits) out.push({ kind: 'edit', edit: e });

	// Coalesce visually-adjacent reasoning segments (no tool/edit/text
	// between them) into a single thinking box. The underlying segments
	// are still persisted distinctly; this is purely a render-time
	// merge so users don't see two "Thought for Xs" boxes back-to-back
	// just because the model emitted a tool that was then cancelled or
	// because the SDK chunked a single thought into two bursts.
	const merged: Part[] = [];
	for (const p of out) {
		const prev = merged[merged.length - 1];
		// Two trimmed segments can't be merged: the merged part would carry a
		// single record id, so only one of them could ever be fetched back.
		// Leave them as separate boxes, each with its own lazy descriptor.
		if (
			p.kind === 'reasoning' &&
			prev &&
			prev.kind === 'reasoning' &&
			prev.block.text !== null &&
			p.block.text !== null
		) {
			// Concatenate text with a blank line separator so the two
			// bursts remain visually distinct inside the same block.
			const text = `${prev.block.text}\n\n${p.block.text}`;
			// Sum finite durations; null wins (still open) so the header
			// keeps ticking via the streaming flag.
			const durationMs =
				prev.block.durationMs == null || p.block.durationMs == null
					? null
					: prev.block.durationMs + p.block.durationMs;
			merged[merged.length - 1] = {
				kind: 'reasoning',
				streaming: prev.streaming || p.streaming,
				block: {
					...prev.block,
					text,
					durationMs
				}
			};
		} else {
			merged.push(p);
		}
	}
	return merged;
}
