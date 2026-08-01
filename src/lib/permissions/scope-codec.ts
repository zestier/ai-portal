// JSON ↔ GrantScope codec with defensive validation.
//
// All grant rows are loaded through `decodeScope` (returns null on any
// malformed input); we never feed structurally invalid JSON to the
// matcher. New rows are serialized with `encodeScope` which guarantees a
// shape the codec will accept.

import {
	type GrantScope,
	type ShellScope,
	type ShellRule,
	type ShellCommandStep,
	type ShellOptionRules,
	type ShellOptionSpec,
	type ShellOptionValueRule,
	type FsScope,
	type UrlScope,
	type UrlRule,
	type PositionalsRule
} from './scope-types';
import { FsScopeSchema } from './scope-schema';

export function encodeScope(scope: GrantScope): string {
	return JSON.stringify(scope);
}

export function stableScopeKey(scope: GrantScope): string {
	return stableJson(scope);
}

export function decodeScope(raw: string | null | undefined): GrantScope | null {
	if (raw == null || raw === '') return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	return validate(parsed);
}

function validate(v: unknown): GrantScope | null {
	if (!isObject(v)) return null;
	const kind = (v as { kind?: unknown }).kind;
	switch (kind) {
		case 'any':
			return { kind: 'any' };
		case 'shell':
			return validateShell(v);
		case 'fs':
			return validateFs(v);
		case 'url':
			return validateUrl(v);
		default:
			return null;
	}
}

function validateShell(v: Record<string, unknown>): ShellScope | null {
	const rule = isObject(v.rule) ? (v.rule as Record<string, unknown>) : null;
	if (!rule) return null;

	const command = validateShellCommandPath(rule.command);
	if (!command) return null;
	const out: ShellRule = { command };

	if (rule.positionals !== undefined) {
		const p = validatePositionals(rule.positionals);
		if (!p) return null;
		out.positionals = p;
	}

	if (rule.pipeline !== undefined) {
		if (rule.pipeline !== 'must' && rule.pipeline !== 'forbid' && rule.pipeline !== 'pipe-target')
			return null;
		out.pipeline = rule.pipeline;
	}

	return { kind: 'shell', rule: out };
}

function validateShellCommandPath(v: unknown): ShellCommandStep[] | null {
	if (!Array.isArray(v) || v.length === 0) return null;
	const command: ShellCommandStep[] = [];
	for (let i = 0; i < v.length; i++) {
		const step = isObject(v[i]) ? (v[i] as Record<string, unknown>) : null;
		if (!step) return null;
		const token = step.token;
		if (typeof token !== 'string' || token.length === 0) return null;
		if (i === 0 && (token.includes('/') || token.startsWith('.'))) return null;
		const out: ShellCommandStep = { token };
		if (step.options !== undefined) {
			const options = validateShellOptionRules(step.options);
			if (!options) return null;
			out.options = options;
		}
		command.push(out);
	}
	return command;
}

function validateShellOptionRules(v: unknown): ShellOptionRules | null {
	if (!isObject(v)) return null;
	const raw = v as Record<string, unknown>;
	const out: ShellOptionRules = {};
	if (raw.allow !== undefined) {
		if (!Array.isArray(raw.allow)) return null;
		const allow: ShellOptionSpec[] = [];
		for (const spec of raw.allow) {
			const parsed = validateShellOptionSpec(spec);
			if (!parsed) return null;
			allow.push(parsed);
		}
		out.allow = allow;
	}
	if (raw.deny !== undefined) {
		const deny = asFlagNameList(raw.deny);
		if (deny === null) return null;
		out.deny = deny;
	}
	if (out.allow === undefined && out.deny === undefined) return null;
	return out;
}

function validateShellOptionSpec(v: unknown): ShellOptionSpec | null {
	if (!isObject(v)) return null;
	const raw = v as Record<string, unknown>;
	if (!isFlagName(raw.name)) return null;
	if (raw.kind === 'flag') return { name: raw.name, kind: 'flag' };
	if (raw.kind !== 'option') return null;
	const value = validateShellOptionValue(raw.value);
	if (!value) return null;
	return { name: raw.name, kind: 'option', value };
}

function validateShellOptionValue(v: unknown): ShellOptionValueRule | null {
	if (!isObject(v)) return null;
	const kind = (v as { kind?: unknown }).kind;
	if (kind === 'any' || kind === 'workspace-path') {
		return { kind } as ShellOptionValueRule;
	}
	return null;
}

function validatePositionals(v: unknown): PositionalsRule | null {
	if (!isObject(v)) return null;
	const kind = (v as { kind?: unknown }).kind;
	if (
		kind === 'none' ||
		kind === 'any' ||
		kind === 'pattern-only' ||
		kind === 'workspace-paths' ||
		kind === 'session-workspace-paths'
	) {
		return { kind } as PositionalsRule;
	}
	return null;
}

function validateFs(v: Record<string, unknown>): FsScope | null {
	const parsed = FsScopeSchema.safeParse(v);
	return parsed.success ? parsed.data : null;
}

function validateUrl(v: Record<string, unknown>): UrlScope | null {
	const rule = isObject(v.rule) ? (v.rule as Record<string, unknown>) : null;
	if (!rule) return null;
	let parsedRule: UrlRule | null = null;
	switch (rule.kind) {
		case 'exact':
			if (typeof rule.url !== 'string' || rule.url.length === 0) return null;
			parsedRule = { kind: 'exact', url: rule.url };
			break;
		case 'host':
			if (typeof rule.host !== 'string' || rule.host.length === 0) return null;
			parsedRule = { kind: 'host', host: rule.host };
			break;
		case 'host-suffix':
			if (typeof rule.suffix !== 'string' || rule.suffix.length === 0) return null;
			parsedRule = { kind: 'host-suffix', suffix: rule.suffix };
			break;
	}
	if (!parsedRule) return null;
	return { kind: 'url', rule: parsedRule };
}

function asStringList(v: unknown): string[] | null {
	if (!Array.isArray(v)) return null;
	const out: string[] = [];
	for (const s of v) {
		if (typeof s !== 'string' || s.length === 0) return null;
		out.push(s);
	}
	return out;
}

function asFlagNameList(v: unknown): string[] | null {
	const out = asStringList(v);
	if (out === null) return null;
	for (const s of out) {
		if (!isFlagName(s)) return null;
	}
	return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isFlagName(v: unknown): v is string {
	return typeof v === 'string' && v.length > 0 && v.startsWith('-');
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0
		);
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
	}
	return JSON.stringify(value);
}
