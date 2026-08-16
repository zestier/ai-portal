import { describe, expect, it } from 'vitest';
import { decideArmedFlush, decideComposerAction } from '../../src/lib/client/composer-arming';

describe('decideComposerAction', () => {
	it('sends immediately when idle with text', () => {
		expect(decideComposerAction({ streaming: false, armed: false, hasText: true })).toBe('send');
	});

	it('does nothing when idle with an empty buffer', () => {
		expect(decideComposerAction({ streaming: false, armed: false, hasText: false })).toBe('noop');
	});

	it('arms a non-empty buffer while a turn streams', () => {
		expect(decideComposerAction({ streaming: true, armed: false, hasText: true })).toBe('arm');
	});

	it('does nothing when streaming with an empty buffer', () => {
		expect(decideComposerAction({ streaming: true, armed: false, hasText: false })).toBe('noop');
	});

	it('disarms when pressed again while already armed', () => {
		expect(decideComposerAction({ streaming: true, armed: true, hasText: true })).toBe('disarm');
	});

	it('still disarms when the armed buffer was emptied', () => {
		expect(decideComposerAction({ streaming: true, armed: true, hasText: false })).toBe('disarm');
	});
});

describe('decideArmedFlush', () => {
	it('flushes a successful armed turn with text', () => {
		expect(decideArmedFlush({ armed: true, failed: false, hasText: true })).toBe('flush');
	});

	it('disarms silently when the armed buffer is empty at flush time', () => {
		expect(decideArmedFlush({ armed: true, failed: false, hasText: false })).toBe('disarm');
	});

	it('holds (disarms, keeps text) when the turn failed', () => {
		expect(decideArmedFlush({ armed: true, failed: true, hasText: true })).toBe('disarm');
	});

	it('does nothing when nothing was armed', () => {
		expect(decideArmedFlush({ armed: false, failed: false, hasText: true })).toBe('noop');
		expect(decideArmedFlush({ armed: false, failed: true, hasText: true })).toBe('noop');
	});
});
