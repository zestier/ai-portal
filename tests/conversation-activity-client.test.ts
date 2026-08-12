import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
	clearConversationActivityOverrides,
	clearConversationUnread,
	conversationActivityOverrides,
	resolveConversationActivity,
	setConversationActivity
} from '../src/lib/client/conversation-activity';

const NONE = new Set<number>();

describe('resolveConversationActivity', () => {
	it('falls back to the server load sets when there is no override', () => {
		expect(resolveConversationActivity(1, new Set([1]), new Set([1]), {})).toEqual({
			running: true,
			unread: true
		});
		expect(resolveConversationActivity(2, new Set([1]), new Set([1]), {})).toEqual({
			running: false,
			unread: false
		});
	});

	it('lets a live override win over the server sets', () => {
		// The feed is fresher than the last `load`, so a finished turn must be
		// able to clear a `running` the server set still reports.
		const overrides = { 1: { running: false, unread: true } };
		expect(resolveConversationActivity(1, new Set([1]), NONE, overrides)).toEqual({
			running: false,
			unread: true
		});
	});

	it('scopes overrides to their own conversation', () => {
		const overrides = { 1: { running: true, unread: false } };
		expect(resolveConversationActivity(2, NONE, new Set([2]), overrides)).toEqual({
			running: false,
			unread: true
		});
	});
});

describe('conversationActivityOverrides', () => {
	it('keeps the same object identity when nothing changed', () => {
		setConversationActivity(1, { running: true, unread: false });
		const first = get(conversationActivityOverrides);
		setConversationActivity(1, { running: true, unread: false });
		// Identity stability matters: the sidebar re-derives every row from this
		// store, and an SSE reconnect replays events verbatim.
		expect(get(conversationActivityOverrides)).toBe(first);

		setConversationActivity(1, { running: false, unread: true });
		expect(get(conversationActivityOverrides)).not.toBe(first);
	});

	it('clears unread without disturbing running', () => {
		setConversationActivity(2, { running: true, unread: true });
		clearConversationUnread(2);
		expect(get(conversationActivityOverrides)[2]).toEqual({ running: true, unread: false });
	});

	it('records a read for a conversation it has never seen an event for', () => {
		clearConversationUnread(3);
		expect(get(conversationActivityOverrides)[3]).toEqual({ running: false, unread: false });
	});

	it('drops every override so the server load can win again', () => {
		setConversationActivity(4, { running: true, unread: true });
		clearConversationActivityOverrides();
		expect(get(conversationActivityOverrides)).toEqual({});
		// With no override left, resolution falls back to the server sets.
		expect(
			resolveConversationActivity(4, NONE, new Set([4]), get(conversationActivityOverrides))
		).toEqual({ running: false, unread: true });
	});
});
