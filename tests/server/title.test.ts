import { describe, it, expect } from 'vitest';
import { deriveTitle, isDefaultTitle } from '../../src/lib/server/title';

describe('deriveTitle', () => {
	it('returns the default title for empty or whitespace input', () => {
		expect(deriveTitle('')).toBe('New chat');
		expect(deriveTitle('   ')).toBe('New chat');
		expect(deriveTitle('\n\n')).toBe('New chat');
	});

	it('returns the default title when only markdown noise is present', () => {
		expect(deriveTitle('```\ncode only\n```')).toBe('New chat');
		expect(deriveTitle('***')).toBe('New chat');
	});

	it('uses the first sentence when short enough', () => {
		expect(deriveTitle('Fix the login bug. Then add tests.')).toBe('Fix the login bug');
	});

	it('does not split on a sentence boundary that is too far in', () => {
		const long =
			'This particular sentence definitely exceeds the configured maximum length on purpose. Second.';
		const out = deriveTitle(long);
		expect(out.length).toBeLessThanOrEqual(60);
		// It should not start with "Second" — i.e., we didn't accidentally
		// keep the long first sentence then chop it; we truncated instead.
		expect(out.startsWith('This')).toBe(true);
	});

	it('strips fenced code blocks', () => {
		const out = deriveTitle('Add caching\n```ts\nfunction foo() {}\n```\nplease');
		expect(out).toBe('Add caching please');
	});

	it('keeps inline code text but drops backticks', () => {
		expect(deriveTitle('Refactor `parseUrl` helper')).toBe('Refactor parseUrl helper');
	});

	it('keeps link labels and drops URLs', () => {
		expect(deriveTitle('See [the docs](https://example.com/x) for details.')).toBe(
			'See the docs for details'
		);
	});

	it('strips markdown heading and list markers from the start of lines', () => {
		expect(deriveTitle('# Big idea')).toBe('Big idea');
		expect(deriveTitle('- do the thing')).toBe('Do the thing');
		expect(deriveTitle('> quoted note')).toBe('Quoted note');
	});

	it('strips emphasis markers', () => {
		expect(deriveTitle('**Bold** _idea_ here')).toBe('Bold idea here');
	});

	it('caps at the configured maximum length', () => {
		const out = deriveTitle('word '.repeat(200));
		expect(out.length).toBeLessThanOrEqual(60);
	});

	it('caps at the configured maximum word count', () => {
		const out = deriveTitle('one two three four five six seven eight nine ten');
		expect(out.split(' ')).toHaveLength(8);
	});

	it('truncates at a word boundary, not mid-word', () => {
		const out = deriveTitle(
			'supercalifragilisticexpialidocious and other extraordinarily long incantations matter'
		);
		expect(out.length).toBeLessThanOrEqual(60);
		// No trailing partial word (single word inputs may exceed, but here
		// we have multiple words, so the last char should not be alphanumeric
		// from a chopped tail unless the boundary regex left it alone).
		expect(out).not.toMatch(/\s+\S{1,2}$/);
	});

	it('capitalizes the first letter without lowercasing the rest', () => {
		expect(deriveTitle('fooBar baz')).toBe('FooBar baz');
		// Intentional: we only uppercase the first character. Acronyms
		// like "iOS" or "iPhone" get clobbered to "IOS" / "IPhone"; that
		// trade-off is fine because the alternative (preserving inner
		// case) would also preserve unwanted internal capitals from
		// noisy prompts. If you "fix" this, add a test case here.
		expect(deriveTitle('iOS bug')).toBe('IOS bug');
	});

	it('strips trailing punctuation', () => {
		expect(deriveTitle('do the thing,')).toBe('Do the thing');
		expect(deriveTitle('do the thing —')).toBe('Do the thing');
	});

	it('collapses internal whitespace', () => {
		expect(deriveTitle('hello   \t  world\n\nfriend')).toBe('Hello world friend');
	});
});

describe('isDefaultTitle', () => {
	it('treats empty / default string as default', () => {
		expect(isDefaultTitle('')).toBe(true);
		expect(isDefaultTitle('New chat')).toBe(true);
		expect(isDefaultTitle('  New chat  ')).toBe(true);
	});

	it('treats any other title as non-default', () => {
		expect(isDefaultTitle('Fix login bug')).toBe(false);
		expect(isDefaultTitle('new chat (1)')).toBe(false);
	});
});
