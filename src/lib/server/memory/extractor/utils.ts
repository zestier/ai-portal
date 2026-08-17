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
export const SENSITIVE_PATTERNS: ReadonlyArray<{
  regex: RegExp;
  replacement: string;
}> = [
  {
    regex: /\bgh[psuor]_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[redacted:github-token]",
  },
  {
    regex: /\b(?:sk-|sk_live_|sk_test_)[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[redacted:api-key]",
  },
  {
    regex:
      /\b((?:bearer|token|api[_-]?key|password|passwd|secret)\b\s*[:=]\s*)["']?[A-Za-z0-9._~+/=-]{12,}/gi,
    replacement: "$1[redacted]",
  },
];

/**
 * Heuristic patterns for instruction-injection phrasing — attempts to override,
 * disable, or exfiltrate the system/developer prompt and safety rules. Unlike
 * {@link SENSITIVE_PATTERNS} (which match credential *shapes*), these match
 * *instruction text*. They exist so a directive rule (which renders into the
 * always-on standing-rules block and re-injects every turn) can't smuggle a
 * persistent prompt-injection payload from summarized/indirect content. Patterns
 * are intentionally narrow — they require an imperative verb *and* a target like
 * "previous instructions" / "system prompt" / a secret — so ordinary behavioural
 * directives ("Keep replies short.", "Never reveal the villain before chapter
 * three.") don't trip them. Non-`g` so `.test()` needs no `lastIndex` reset.
 */
export const PROMPT_INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:ignore|disregard|forget|override|bypass|skip|drop)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|the|your|these|those)\b[^.\n]{0,40}\b(?:instruction|instructions|direction|directions|prompt|prompts|rule|rules|guideline|guidelines|constraint|constraints|context|memory|memories)\b/i,
  /\b(?:from now on|starting now|going forward)\b[^.\n]{0,30}\byou(?:'re| are| will| must| should| now)/i,
  /\byou are now\b/i,
  /\b(?:act|behave|respond|pretend|roleplay|operate)\s+as\s+(?:if\s+)?(?:you\s+are\s+)?(?:an?\s+)?(?:dan|developer\s*mode|jailbroken|unrestricted|unfiltered|no[\s-]?restrictions?)/i,
  /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/i,
  /\b(?:reveal|print|show|output|repeat|disclose|leak|exfiltrate|send|email|post)\b[^.\n]{0,40}\b(?:system\s+prompt|hidden\s+instructions?|api[_-]?key|password|passwd|secret|credentials?|token)/i,
  /<\/?\s*(?:system|assistant|developer|instructions?)\s*>/i,
  /\[\/?\s*(?:system|inst|instructions?)\s*\]/i,
  /\bdo anything now\b/i,
  /\bdeveloper mode\b/i,
  /\bdisregard\b[^.\n]{0,30}\b(?:safety|content|moderation)\b[^.\n]{0,20}\b(?:polic|guideline|rule|filter)/i,
];

/**
 * Candidate normalizations to scan before matching the injection patterns. The
 * patterns bridge tokens with `[^.\n]{0,40}` gaps that exclude newlines and
 * anchor every required token with `\b`, so an attacker can split a phrase two
 * ways: across a *newline* between tokens, or with a *zero-width* char either
 * inside a word ("ig\u200bnore") or between two words ("ignore\u200ball"). No
 * single rewrite defeats both zero-width variants against `\b`: deleting the
 * char rejoins an intra-word split ("ig\u200bnore" → "ignore") but merges an
 * inter-word split ("ignore\u200ball" → "ignoreall", destroying the boundary),
 * while substituting a space does the reverse. So we produce both: whitespace is
 * always collapsed to single spaces (closing the newline bypass), and zero-width
 * / soft-hyphen chars are once *removed* and once *replaced with a space*. A
 * match against either variant counts. The sentence-boundary (`.`) guard is left
 * intact in both, so ordinary multi-sentence text doesn't newly trip.
 */
function normalizeForInjectionScan(text: string): string[] {
  const collapsed = text.replace(/\s+/g, " ");
  const zeroWidth = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
  return [
    collapsed.replace(zeroWidth, ""),
    collapsed.replace(zeroWidth, " ").replace(/\s+/g, " "),
  ];
}

/**
 * Whether `text` reads like an attempt to override or exfiltrate the system
 * prompt / safety rules (see {@link PROMPT_INJECTION_PATTERNS}). Used to reject
 * such text from persistent, high-authority storage (standing directives).
 */
export function looksLikePromptInjection(text: string): boolean {
  if (!text) return false;
  const variants = normalizeForInjectionScan(text);
  return PROMPT_INJECTION_PATTERNS.some((regex) =>
    variants.some((variant) => regex.test(variant)),
  );
}

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
    if (url.username) url.username = "[redacted]";
    if (url.password) url.password = "[redacted]";
    url.search = "";
    return url.toString();
  } catch {
    return redactSensitiveText(raw);
  }
}

export function excerptResponseBody(text: string): string | null {
  const normalized = redactSensitiveText(text).replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 500
    ? `${normalized.slice(0, 500)}...`
    : normalized;
}

export function extractProviderErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  for (const key of ["message", "detail", "error_description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
