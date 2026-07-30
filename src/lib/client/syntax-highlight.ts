import type { HLJSApi, LanguageFn } from 'highlight.js';

export type HighlightLanguage =
	| 'typescript'
	| 'javascript'
	| 'svelte'
	| 'html'
	| 'css'
	| 'json'
	| 'markdown'
	| 'bash'
	| 'python'
	| 'go'
	| 'rust'
	| 'sql'
	| 'yaml'
	| 'diff';

export const MAX_HIGHLIGHT_CHARS = 200_000;
export const MAX_HIGHLIGHT_LINES = 5_000;

const EXTENSION_LANGUAGES: Record<string, HighlightLanguage> = {
	ts: 'typescript',
	tsx: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	js: 'javascript',
	jsx: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	svelte: 'svelte',
	html: 'html',
	htm: 'html',
	xml: 'html',
	svg: 'html',
	css: 'css',
	scss: 'css',
	sass: 'css',
	less: 'css',
	json: 'json',
	jsonc: 'json',
	md: 'markdown',
	markdown: 'markdown',
	sh: 'bash',
	bash: 'bash',
	zsh: 'bash',
	fish: 'bash',
	py: 'python',
	pyw: 'python',
	go: 'go',
	rs: 'rust',
	sql: 'sql',
	yml: 'yaml',
	yaml: 'yaml',
	diff: 'diff',
	patch: 'diff'
};

const BASENAME_LANGUAGES: Record<string, HighlightLanguage> = {
	dockerfile: 'bash',
	makefile: 'bash',
	'.bashrc': 'bash',
	'.zshrc': 'bash',
	'.profile': 'bash',
	'.env': 'bash',
	'pnpm-lock.yaml': 'yaml',
	'package.json': 'json',
	'tsconfig.json': 'json'
};

let highlighterPromise: Promise<HLJSApi> | null = null;
const registered = new Set<HighlightLanguage>();

export function languageForPath(path: string | null | undefined): HighlightLanguage | null {
	if (!path) return null;
	const cleaned = path.split(/[?#]/u, 1)[0]?.trim() ?? '';
	const renamedTarget = cleaned.includes(' -> ') ? cleaned.split(' -> ').at(-1) : cleaned;
	const basename = (renamedTarget ?? '').split('/').at(-1)?.toLowerCase() ?? '';
	if (BASENAME_LANGUAGES[basename]) return BASENAME_LANGUAGES[basename];
	const extension = basename.includes('.') ? basename.split('.').at(-1) : '';
	return extension ? (EXTENSION_LANGUAGES[extension] ?? null) : null;
}

export function escapeHtml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

export function canHighlight(lines: readonly string[]): boolean {
	if (lines.length > MAX_HIGHLIGHT_LINES) return false;
	let chars = 0;
	for (const line of lines) {
		chars += line.length + 1;
		if (chars > MAX_HIGHLIGHT_CHARS) return false;
	}
	return true;
}

async function loadHighlighter(): Promise<HLJSApi> {
	highlighterPromise ??= import('highlight.js/lib/core').then((mod) => mod.default);
	return highlighterPromise;
}

async function loadLanguage(language: HighlightLanguage): Promise<LanguageFn> {
	switch (language) {
		case 'typescript':
			return (await import('highlight.js/lib/languages/typescript')).default;
		case 'javascript':
			return (await import('highlight.js/lib/languages/javascript')).default;
		case 'svelte':
		case 'html':
			return (await import('highlight.js/lib/languages/xml')).default;
		case 'css':
			return (await import('highlight.js/lib/languages/css')).default;
		case 'json':
			return (await import('highlight.js/lib/languages/json')).default;
		case 'markdown':
			return (await import('highlight.js/lib/languages/markdown')).default;
		case 'bash':
			return (await import('highlight.js/lib/languages/bash')).default;
		case 'python':
			return (await import('highlight.js/lib/languages/python')).default;
		case 'go':
			return (await import('highlight.js/lib/languages/go')).default;
		case 'rust':
			return (await import('highlight.js/lib/languages/rust')).default;
		case 'sql':
			return (await import('highlight.js/lib/languages/sql')).default;
		case 'yaml':
			return (await import('highlight.js/lib/languages/yaml')).default;
		case 'diff':
			return (await import('highlight.js/lib/languages/diff')).default;
	}
}

async function ensureLanguage(language: HighlightLanguage): Promise<HLJSApi> {
	const hljs = await loadHighlighter();
	if (!registered.has(language)) {
		hljs.registerLanguage(language, await loadLanguage(language));
		registered.add(language);
	}
	return hljs;
}

export interface HighlightedLines {
	html: string[];
	highlighted: boolean;
	skipped: boolean;
	language: HighlightLanguage | null;
}

// Highlighting is per line rather than per file: the diff surfaces only ever
// have a line at a time to colour, and a file's rows are rendered as individual
// elements so a span cannot straddle them. The tradeoff is that constructs
// spanning lines (block comments, template literals) are coloured line-locally.
export async function highlightCodeLines(
	lines: readonly string[],
	language: HighlightLanguage | null
): Promise<HighlightedLines> {
	const fallback = () => lines.map(escapeHtml);
	if (!language || !canHighlight(lines)) {
		return { html: fallback(), highlighted: false, skipped: !!language, language };
	}
	try {
		const hljs = await ensureLanguage(language);
		return {
			html: lines.map((line) =>
				line === '' ? '' : hljs.highlight(line, { language, ignoreIllegals: true }).value
			),
			highlighted: true,
			skipped: false,
			language
		};
	} catch {
		return { html: fallback(), highlighted: false, skipped: false, language };
	}
}
