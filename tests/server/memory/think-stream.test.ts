import { describe, expect, it } from 'vitest';
import { makeThinkStream } from '../../../src/lib/server/memory/extractor';

/**
 * Feed a string through `makeThinkStream` one chunk at a time and concatenate
 * the classified output, so tests can assert how think vs visible text is split
 * regardless of where the chunk boundaries fall.
 */
function run(chunks: string[]): { think: string; visible: string } {
	const stream = makeThinkStream();
	let think = '';
	let visible = '';
	for (const chunk of chunks) {
		const out = stream.push(chunk);
		think += out.think;
		visible += out.visible;
	}
	const tail = stream.flush();
	think += tail.think;
	visible += tail.visible;
	return { think, visible };
}

describe('makeThinkStream', () => {
	it('passes plain content through as visible', () => {
		expect(run(['hello world'])).toEqual({ think: '', visible: 'hello world' });
	});

	it('separates a <think> block from spoken content', () => {
		expect(run(['before <think>secret</think> after'])).toEqual({
			think: 'secret',
			visible: 'before  after'
		});
	});

	it('handles a tag split across chunk boundaries', () => {
		// The opening tag is fragmented across three chunks.
		expect(run(['a <thi', 'nk>hidden</thi', 'nk> b'])).toEqual({
			think: 'hidden',
			visible: 'a  b'
		});
	});

	it('treats non-think angle-bracket text as visible', () => {
		expect(run(['use <div> and <span>'])).toEqual({
			think: '',
			visible: 'use <div> and <span>'
		});
	});

	it('supports the <thinking> alias', () => {
		expect(run(['x <thinking>y</thinking> z'])).toEqual({
			think: 'y',
			visible: 'x  z'
		});
	});

	it('flushes an unterminated think block as think text', () => {
		// Stream ends while still inside a think block.
		expect(run(['talk <think>still going'])).toEqual({
			think: 'still going',
			visible: 'talk '
		});
	});

	it('flushes a dangling partial tag prefix as visible', () => {
		// Buffered "<thi" never completes into a tag.
		expect(run(['done <thi'])).toEqual({ think: '', visible: 'done <thi' });
	});

	it('classifies content emitted one character at a time', () => {
		expect(run([...'p <think>q</think> r'])).toEqual({
			think: 'q',
			visible: 'p  r'
		});
	});
});
