import {
	type GrantScope,
	type ShellCommandStep,
	type ShellRule
} from '$lib/permissions/scope-types';
import { stableScopeKey } from '$lib/permissions/scope-codec';

export interface SeedSpec {
	tool: string;
	permissionKind: string | null;
	scope?: GrantScope | null;
	scopePattern?: string | null;
	decision?: 'allow' | 'deny' | 'prompt';
	denyReason?: string;
}

/**
 * Shell tools with no path arguments (pure stdout-only utilities). Safe
 * to allow with any positionals because they don't touch the filesystem
 * beyond reading their own argv.
 *
 * Deliberately NOT moved to `readable-paths` with the fs-read tools: these
 * never open a file. `basename` / `dirname` take path-SHAPED operands but only
 * do string surgery on them, so requiring a `read` grant would refuse a
 * perfectly safe call and teach users to over-grant.
 */
export const PURE_UTILS = [
	'echo',
	'printf',
	'pwd',
	'date',
	'whoami',
	'hostname',
	'uname',
	'true',
	'false',
	'basename',
	'dirname',
	'yes',
	// `tr` sits here rather than with the fs-read tools because it has no file
	// operands at all: its positionals are SET1 / SET2 (character sets), and it
	// only ever transforms stdin. Judging those as paths was the same category
	// error the old `grep` seed made — `tr -d /` names the character `/`, not
	// the root directory, and a path rule refuses it for a reason that does not
	// exist. It cannot open, read, or write a file, so `any` is the honest rule.
	'tr'
];

export function shellGrant(rule: ShellRule): SeedSpec {
	return { tool: 'shell', permissionKind: 'shell', scope: { kind: 'shell', rule } };
}

export function shellCommand(
	token: string,
	positionals: ShellRule['positionals'],
	options?: ShellCommandStep['options']
): ShellRule {
	const step: ShellCommandStep = { token };
	if (options) step.options = options;
	return {
		command: [step],
		...(positionals !== undefined ? { positionals } : {})
	};
}

/**
 * A grant-deferring reader seed only fires when there is at least one operand
 * to actually check. Without this it would match vacuously on a zero-positional
 * invocation and auto-approve on the strength of a rule that examined nothing.
 */
export function deferredReader(rule: ShellRule): ShellRule {
	return { ...rule, positionalCount: { ...rule.positionalCount, min: 1 } };
}

/** Applies a reader's audited upper bound on operands, if it has one. */
export function boundPositionals(rule: ShellRule, max: number | undefined): ShellRule {
	if (max === undefined) return rule;
	return { ...rule, positionalCount: { ...rule.positionalCount, max } };
}

export function shellPrompt(rule: ShellRule, reason: string): SeedSpec {
	return {
		tool: 'shell',
		permissionKind: 'shell',
		scope: { kind: 'shell', rule },
		decision: 'prompt',
		denyReason: reason
	};
}

export function shellDeny(rule: ShellRule, reason: string): SeedSpec {
	return {
		tool: 'shell',
		permissionKind: 'shell',
		scope: { kind: 'shell', rule },
		decision: 'deny',
		denyReason: reason
	};
}

export function shellPatternDeny(pattern: string, reason: string): SeedSpec {
	return {
		tool: 'shell',
		permissionKind: 'shell',
		scopePattern: pattern,
		decision: 'deny',
		denyReason: reason
	};
}

export function seedKey(
	tool: string,
	kind: string | null,
	scope: GrantScope | null,
	pattern: string | null,
	decision: string
): string {
	return `${tool}\u0000${kind ?? ''}\u0000${decision}\u0000${scope ? stableScopeKey(scope) : `pattern:${pattern ?? ''}`}`;
}
