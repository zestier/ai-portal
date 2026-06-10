/**
 * Small, dependency-free helpers shared across the extractor modules: text
 * redaction/truncation and provider-response error extraction. Kept separate so
 * the extractor implementations and HTTP plumbing can share them without pulling
 * in the larger modules.
 */

/**
 * Source patterns for common secret shapes — GitHub tokens, OpenAI-style API
 * keys, and `key: value` secrets (bearer/token/api-key/password/secret). Shared
 * by {@link redactSensitiveText} (free-text redaction) and the post-extraction
 * secret filter in `sanitize.ts` so the two can't drift apart. Each regex is
 * `g`-flagged for `String.replace`; the `key:` form keeps its leading `$1`
 * capture so only the value is redacted. Because these are stateful (`g`),
 * callers using `.test()` must reset `lastIndex` first.
 */
export const SENSITIVE_PATTERNS: ReadonlyArray<{ regex: RegExp; replacement: string }> = [
	{ regex: /\bgh[psuor]_[A-Za-z0-9_]{20,}\b/g, replacement: '[redacted:github-token]' },
	{ regex: /\b(?:sk-|sk_live_|sk_test_)[A-Za-z0-9_-]{20,}\b/g, replacement: '[redacted:api-key]' },
	{
		regex:
			/\b((?:bearer|token|api[_-]?key|password|passwd|secret)\b\s*[:=]\s*)["']?[A-Za-z0-9._~+/=-]{12,}/gi,
		replacement: '$1[redacted]'
	}
];

/** Whether `text` matches any known secret shape (see {@link SENSITIVE_PATTERNS}). */
export function containsSensitiveText(text: string): boolean {
	if (!text) return false;
	return SENSITIVE_PATTERNS.some(({ regex }) => {
		regex.lastIndex = 0;
		return regex.test(text);
	});
}

/** Redact common secret shapes (tokens, API keys, `key: value` secrets) from free text. */
export function redactSensitiveText(text: string): string {
	let out = text;
	for (const { regex, replacement } of SENSITIVE_PATTERNS) {
		out = out.replace(regex, replacement);
	}
	return out;
}

export function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[truncated]`;
}

export function stringifyUnknown(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Strip credentials and query string from an endpoint URL for safe logging. */
export function redactEndpoint(raw: string): string {
	try {
		const url = new URL(raw);
		if (url.username) url.username = '[redacted]';
		if (url.password) url.password = '[redacted]';
		url.search = '';
		return url.toString();
	} catch {
		return redactSensitiveText(raw);
	}
}

export function excerptResponseBody(text: string): string | null {
	const normalized = redactSensitiveText(text).replace(/\s+/g, ' ').trim();
	if (!normalized) return null;
	return normalized.length > 500 ? `${normalized.slice(0, 500)}...` : normalized;
}

export function extractProviderErrorMessage(body: unknown): string | null {
	if (!body || typeof body !== 'object') return null;
	const record = body as Record<string, unknown>;
	const error = record.error;
	if (error && typeof error === 'object') {
		const message = (error as Record<string, unknown>).message;
		if (typeof message === 'string' && message.trim()) return message.trim();
	}
	for (const key of ['message', 'detail', 'error_description']) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return null;
}
