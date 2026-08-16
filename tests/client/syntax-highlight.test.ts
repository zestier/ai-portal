import { describe, expect, it } from 'vitest';
import {
	MAX_HIGHLIGHT_CHARS,
	MAX_HIGHLIGHT_LINES,
	canHighlight,
	escapeHtml,
	highlightCodeLines,
	languageForPath
} from '../../src/lib/client/syntax-highlight';

describe('languageForPath', () => {
	it('detects the curated languages used by file and diff views', () => {
		expect(languageForPath('src/App.svelte')).toBe('svelte');
		expect(languageForPath('src/lib/client/syntax-highlight.ts')).toBe('typescript');
		expect(languageForPath('scripts/dev-isolated.mjs')).toBe('javascript');
		expect(languageForPath('docs/frontend-ui.md')).toBe('markdown');
		expect(languageForPath('pnpm-lock.yaml')).toBe('yaml');
		expect(languageForPath('schema.sql')).toBe('sql');
		expect(languageForPath('fix.patch')).toBe('diff');
	});

	it('uses the renamed target path and falls back for unknown files', () => {
		expect(languageForPath('src/old.txt -> src/new.go')).toBe('go');
		expect(languageForPath('README')).toBeNull();
		expect(languageForPath(null)).toBeNull();
	});
});

describe('highlightCodeLines', () => {
	it('escapes unsupported languages without injecting markup', async () => {
		const result = await highlightCodeLines(['<img src=x onerror=alert(1)>'], null);

		expect(result.highlighted).toBe(false);
		expect(result.skipped).toBe(false);
		expect(result.html).toEqual(['&lt;img src=x onerror=alert(1)&gt;']);
	});

	it('loads a registered language lazily and returns escaped span markup', async () => {
		const result = await highlightCodeLines(['const x = "<script>";'], 'typescript');

		expect(result.highlighted).toBe(true);
		expect(result.html[0]).toContain('hljs-keyword');
		expect(result.html[0]).toContain('&quot;&lt;script&gt;&quot;');
		expect(result.html[0]).not.toContain('<script>');
	});

	it('skips large inputs before loading the highlighter', async () => {
		const result = await highlightCodeLines(['x'.repeat(MAX_HIGHLIGHT_CHARS + 1)], 'typescript');

		expect(result.highlighted).toBe(false);
		expect(result.skipped).toBe(true);
		expect(result.html[0]).toBe('x'.repeat(MAX_HIGHLIGHT_CHARS + 1));
	});
});

describe('canHighlight', () => {
	it('enforces line and byte caps', () => {
		expect(canHighlight(Array.from({ length: MAX_HIGHLIGHT_LINES }, () => 'x'))).toBe(true);
		expect(canHighlight(Array.from({ length: MAX_HIGHLIGHT_LINES + 1 }, () => 'x'))).toBe(false);
		expect(canHighlight(['x'.repeat(MAX_HIGHLIGHT_CHARS + 1)])).toBe(false);
	});
});

describe('escapeHtml', () => {
	it('escapes all HTML-sensitive characters', () => {
		expect(escapeHtml(`<tag attr="a&b">'`)).toBe('&lt;tag attr=&quot;a&amp;b&quot;&gt;&#39;');
	});
});
