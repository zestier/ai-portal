import { describe, expect, it } from 'vitest';
import {
	conversationId,
	makeId,
	messageId,
	memoryEntityId,
	memoryFactId,
	memoryPatchItemId,
	promptTemplateId,
	ticketId,
	toolCallId
} from '$lib/ids';

describe('makeId', () => {
	it('round-trips encode -> parse', () => {
		expect(ticketId.encode(10)).toBe('T10');
		expect(ticketId.parse('T10')).toBe(10);
		expect(ticketId.parse(ticketId.encode(1))).toBe(1);
		expect(ticketId.parse(ticketId.encode(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
	});

	it('parses case-insensitively but always encodes the canonical prefix', () => {
		expect(ticketId.parse('t10')).toBe(10);
		expect(ticketId.parse('t10')).toBe(10);
		expect(ticketId.encode(7)).toBe('T7');
	});

	it('is() accepts valid handles and rejects everything else', () => {
		expect(ticketId.is('T10')).toBe(true);
		expect(ticketId.is('t10')).toBe(true);
		expect(ticketId.is(10)).toBe(false);
		expect(ticketId.is('10')).toBe(false);
		expect(ticketId.is('T007')).toBe(false);
		expect(ticketId.is('T0')).toBe(false);
		expect(ticketId.is('TX')).toBe(false);
		expect(ticketId.is(null)).toBe(false);
		expect(ticketId.is(undefined)).toBe(false);
		expect(ticketId.is('')).toBe(false);
	});

	it('rejects numeric-only input', () => {
		expect(() => ticketId.parse('10')).toThrow('not a ticket id: 10 — expected T<number>');
		expect(ticketId.is('10')).toBe(false);
	});

	it('rejects a wrong prefix', () => {
		expect(() => ticketId.parse('C10')).toThrow('not a ticket id: C10 — expected T<number>');
		expect(() => ticketId.parse('X10')).toThrow('not a ticket id: X10 — expected T<number>');
	});

	it('rejects leading zeros', () => {
		expect(() => ticketId.parse('T007')).toThrow('not a ticket id: T007 — expected T<number>');
		expect(() => ticketId.parse('T00001')).toThrow();
	});

	it('rejects zero and negatives', () => {
		expect(() => ticketId.parse('T0')).toThrow('not a ticket id: T0 — expected T<number>');
		expect(() => ticketId.parse('T-1')).toThrow('not a ticket id: T-1 — expected T<number>');
	});

	it('rejects non-safe integers', () => {
		// 9e15 > MAX_SAFE_INTEGER (9007199254740991) — parses to a float / unsafe int.
		expect(() => ticketId.parse('T9007199254740992')).toThrow('not a ticket id: T9007199254740992');
		expect(() => ticketId.parse('T99999999999999999999')).toThrow();
	});

	it('rejects junk', () => {
		expect(() => ticketId.parse('')).toThrow();
		expect(() => ticketId.parse('T')).toThrow();
		expect(() => ticketId.parse('TX')).toThrow();
		expect(() => ticketId.parse('T10 ')).toThrow();
		expect(() => ticketId.parse(' T10')).toThrow();
		expect(() => ticketId.parse('T10x')).toThrow();
		expect(() => ticketId.parse('t1e10')).toThrow();
	});

	it('encode rejects non-positive and non-safe integers', () => {
		expect(() => ticketId.encode(0)).toThrow();
		expect(() => ticketId.encode(-1)).toThrow();
		expect(() => ticketId.encode(1.5)).toThrow();
		expect(() => ticketId.encode(Number.MAX_SAFE_INTEGER + 1)).toThrow();
		expect(() => ticketId.encode(NaN)).toThrow();
		expect(() => ticketId.encode(Infinity)).toThrow();
	});

	it('error() produces a precise, greppable message', () => {
		expect(ticketId.error('10')).toBe('not a ticket id: 10 — expected T<number>');
		expect(ticketId.error('T007')).toBe('not a ticket id: T007 — expected T<number>');
		expect(ticketId.error(10)).toBe('not a ticket id: 10 — expected T<number>');
		expect(ticketId.error(null)).toBe('not a ticket id: null — expected T<number>');
	});

	it('tryParse returns null instead of throwing', () => {
		expect(ticketId.tryParse('T10')).toBe(10);
		expect(ticketId.tryParse('10')).toBe(null);
		expect(ticketId.tryParse('T007')).toBe(null);
		expect(ticketId.tryParse(10)).toBe(null);
		expect(ticketId.tryParse('T99999999999999999999')).toBe(null);
	});

	it('multi-letter prefixes work (PT, PC)', () => {
		expect(promptTemplateId.encode(3)).toBe('PT3');
		expect(promptTemplateId.parse('PT3')).toBe(3);
		expect(promptTemplateId.parse('pt3')).toBe(3);
		expect(() => promptTemplateId.parse('P3')).toThrow('not a prompt template id: P3');
		expect(memoryPatchItemId.parse('PC9')).toBe(9);
	});

	it('guards the prefix against non-uppercase input', () => {
		expect(() => makeId({ prefix: 't', label: 'bad' })).toThrow(/uppercase/);
		expect(() => makeId({ prefix: '1', label: 'bad' })).toThrow(/uppercase/);
	});
});

describe('prefixed handle instances', () => {
	it('each entity has its own anchored prefix', () => {
		expect(conversationId.encode(5)).toBe('C5');
		expect(messageId.encode(5)).toBe('M5');
		expect(toolCallId.encode(5)).toBe('X5');
		expect(memoryEntityId.encode(5)).toBe('E5');
		expect(memoryFactId.encode(5)).toBe('F5');
	});

	it('conversation/message/tool-call ids do not cross-parse', () => {
		expect(conversationId.is('M5')).toBe(false);
		expect(messageId.is('C5')).toBe(false);
		expect(toolCallId.is('M5')).toBe(false);
		expect(() => conversationId.parse('M5')).toThrow('not a conversation id: M5');
		expect(() => messageId.parse('C5')).toThrow('not a message id: C5');
		expect(() => toolCallId.parse('X')).toThrow('not a tool call id: X');
	});
});

describe('nested-prefix safety', () => {
	it('a fact parser rejects a handle that merely starts with its prefix', () => {
		// 'FE7' starts with the fact prefix 'F' but is really a (hypothetical)
		// file-edit id: the anchored regex refuses 'E7' as a numeric part.
		expect(() => memoryFactId.parse('FE7')).toThrow(
			'not a memory fact id: FE7 — expected F<number>'
		);
		expect(memoryFactId.is('FE7')).toBe(false);
		expect(() => memoryFactId.parse('F7E')).toThrow();
	});

	it('a nested-prefix parser accepts the same string', () => {
		// A hypothetical file-edit id 'FE' nests under 'F'; its own parser owns
		// the longer prefix and parses the string the fact parser rejects.
		const fileEditId = makeId({ prefix: 'FE', label: 'file edit' });
		expect(fileEditId.parse('FE7')).toBe(7);
		expect(fileEditId.is('FE7')).toBe(true);
		// ... and the fact parser still rejects the full 'FE7' even though 'F'
		// is a prefix of 'FE'.
		expect(() => memoryFactId.parse('FE7')).toThrow();
	});
});
