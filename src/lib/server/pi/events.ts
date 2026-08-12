// Maps pi `AgentSessionEvent`s to portal `PortalEvent`s so the pi session can
// reuse the turn-runner's existing dispatch / persistence / SSE pipeline
// unchanged (see runtime/turn-runner.ts).
//
// The mapper carries the per-turn reasoning-segment state: pi streams thinking
// as one block per content index, and we keep each burst a single segment
// closed at `thinking_end` / `message_end`, mirroring the claude-agent
// provider's burst-close semantics so think/text interleaving survives.

import { ulid } from 'ulid';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { PortalEvent } from '$lib/types';

const TOOL_SUMMARY_MAX = 200;

export class PiEventMapper {
	readonly messageId: string;
	// Open reasoning bursts keyed by pi's content index (one per thinking block).
	private reasoningSegments = new Map<number, { segmentId: string; startedAt: number }>();
	private messageEnded = false;
	private emittedError = false;

	constructor(messageId: string) {
		this.messageId = messageId;
	}

	/** True once a stream-level error event has been emitted (abort or failure). */
	get hasError(): boolean {
		return this.emittedError;
	}

	/** True once pi's `message_end` for this turn has been seen. */
	get ended(): boolean {
		return this.messageEnded;
	}

	map(event: AgentSessionEvent): PortalEvent[] {
		switch (event.type) {
			case 'message_start':
				return [{ type: 'message.start', messageId: this.messageId, role: 'assistant' }];
			case 'message_update':
				return this.mapMessageUpdate(event.assistantMessageEvent);
			case 'message_end':
				this.messageEnded = true;
				return [{ type: 'message.end', messageId: this.messageId }];
			case 'tool_execution_start':
				return [
					{
						type: 'tool.call',
						toolCallId: event.toolCallId,
						tool: event.toolName,
						args: event.args,
						messageId: this.messageId
					}
				];
			case 'tool_execution_end':
				return [
					{
						type: 'tool.result',
						toolCallId: event.toolCallId,
						ok: !event.isError,
						summary: toolResultSummary(event.result)
					}
				];
			default:
				// agent_start / agent_end / turn_start / turn_end / queue_update
				// etc. carry nothing the portal renders; agent_end terminates the
				// send() stream (handled in session.ts), the rest is noise.
				return [];
		}
	}

	// Close any reasoning bursts left open when the run ends (abort, stream
	// error) so the persisted assistant message has no dangling segments.
	closeReasoning(): PortalEvent[] {
		const out: PortalEvent[] = [];
		for (const [contentIndex, seg] of this.reasoningSegments) {
			out.push({
				type: 'message.reasoning.end',
				messageId: this.messageId,
				segmentId: seg.segmentId,
				durationMs: Date.now() - seg.startedAt
			});
			this.reasoningSegments.delete(contentIndex);
		}
		return out;
	}

	private mapMessageUpdate(event: {
		type: string;
		contentIndex?: number;
		delta?: string;
		error?: { errorMessage?: string };
	}): PortalEvent[] {
		switch (event.type) {
			case 'text_delta':
				return [{ type: 'message.delta', messageId: this.messageId, text: event.delta ?? '' }];
			case 'thinking_delta': {
				const contentIndex = event.contentIndex ?? 0;
				let seg = this.reasoningSegments.get(contentIndex);
				if (!seg) {
					seg = { segmentId: ulid(), startedAt: Date.now() };
					this.reasoningSegments.set(contentIndex, seg);
				}
				return [
					{
						type: 'message.reasoning',
						messageId: this.messageId,
						segmentId: seg.segmentId,
						text: event.delta ?? ''
					}
				];
			}
			case 'thinking_end': {
				const contentIndex = event.contentIndex ?? 0;
				const seg = this.reasoningSegments.get(contentIndex);
				this.reasoningSegments.delete(contentIndex);
				if (!seg) return [];
				return [
					{
						type: 'message.reasoning.end',
						messageId: this.messageId,
						segmentId: seg.segmentId,
						durationMs: Date.now() - seg.startedAt
					}
				];
			}
			case 'error':
				this.emittedError = true;
				return [
					{
						type: 'error',
						code: 'pi_stream_error',
						message: event.error?.errorMessage ?? 'pi stream error'
					}
				];
			default:
				// text_start / text_end / thinking_start / toolcall_* carry no
				// renderable delta.
				return [];
		}
	}
}

function toolResultSummary(result: unknown): string {
	const content = isRecord(result) ? result.content : undefined;
	if (Array.isArray(content)) {
		const text = content
			.map((part) =>
				typeof part === 'string'
					? part
					: isRecord(part) && typeof part.text === 'string'
						? part.text
						: ''
			)
			.join('\n')
			.replace(/\s+/g, ' ')
			.trim();
		if (text)
			return text.length > TOOL_SUMMARY_MAX ? `${text.slice(0, TOOL_SUMMARY_MAX - 3)}...` : text;
	}
	return '(empty result)';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
