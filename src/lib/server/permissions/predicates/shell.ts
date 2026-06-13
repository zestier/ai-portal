// Predicate for ShellScope grants — `shell` permission requests.
//
// Callers are expected to have already run the command through
// `shell-parser` and refused to consider structured grants for commands
// the parser couldn't fully understand. This module focuses on the
// structural question: does this rule cover this argv?

import type {
	ShellRule,
	PositionalsRule,
	ShellOptionSpec,
	ShellCommandStep,
	ShellOptionRules
} from '../../../permissions/scope-types';
import { looksLikeShellOptionToken, matchShellOptionToken } from '../../../permissions/shell-argv';
import type { ParsedSegment } from '../shell-parser';
import { isPathInWorkspace } from '../workspace';

export interface ShellMatchContext {
	/** Conversation's workspace root. `workspace-paths` fails closed when null. */
	workspaceRoot: string | null;
	/** SDK session workspace root. `session-workspace-paths` fails closed when null. */
	sessionWorkspaceRoot?: string | null;
	/** Whether the segment being evaluated is part of a shell pipeline
	 * (connected to a neighboring command by `|`). Used by the rule's
	 * `pipeline: 'must' | 'forbid'` lever. Defaults to false when
	 * unspecified — callers that don't pass it are treating each segment
	 * as standalone, which is the safe assumption for `'must'` (it'll
	 * fail closed) and the correct one for `'forbid'`. */
	inPipeline?: boolean;
}

/**
 * Returns true iff EVERY segment of the parsed command satisfies this
 * rule. Pipelines and chains (`a && b`, `a | b`) must satisfy the same
 * rule on every segment — callers wanting different rules per segment
 * should issue separate grants and let the matcher OR them.
 *
 * The pipeline lever (`rule.pipeline`) is evaluated per-segment using
 * the segment's followingOp / its predecessor's followingOp, so a rule
 * with `pipeline: 'forbid'` rejects a multi-segment pipeline even
 * though the rule otherwise covers each command.
 */
export function shellRuleMatches(
	rule: ShellRule,
	segments: ParsedSegment[],
	ctx: ShellMatchContext
): boolean {
	if (segments.length === 0) return false;
	for (let i = 0; i < segments.length; i++) {
		const inPipeline =
			segments[i].followingOp === '|' || (i > 0 && segments[i - 1].followingOp === '|');
		if (!shellRuleMatchesSegment(rule, segments[i], { ...ctx, inPipeline })) return false;
	}
	return true;
}

/**
 * Returns true iff this single parsed segment satisfies the rule.
 * The matcher uses this directly to evaluate each segment of a chained
 * command independently — one rule may cover `cd ./src`, a different
 * rule may cover the `git diff` that follows the `&&`, and the request
 * is allowed as long as every segment has some allow rule covering it
 * (and none have a deny). Single-rule "all segments" callers should
 * keep using `shellRuleMatches`.
 */
export function shellRuleMatchesSegment(
	rule: ShellRule,
	seg: ParsedSegment,
	ctx: ShellMatchContext
): boolean {
	const argv = seg.argv;
	if (argv.length === 0) return false;
	const path = rule.command;
	if (path.length === 0) return false;

	if (rule.pipeline) {
		const inPipeline = ctx.inPipeline === true;
		if (rule.pipeline === 'must' && !inPipeline) return false;
		if (rule.pipeline === 'forbid' && inPipeline) return false;
	}

	return commandPathMatches(path, argv, rule.positionals, ctx);
}

function commandPathMatches(
	path: ShellCommandStep[],
	argv: string[],
	positionalsRule: PositionalsRule | undefined,
	ctx: ShellMatchContext
): boolean {
	if (path.length === 0 || argv[0] !== path[0].token) return false;

	const ignored = new Set<number>([0]);
	let bodyStartIndex = 1;

	for (let stepIndex = 0; stepIndex < path.length - 1; stepIndex++) {
		const current = path[stepIndex];
		const next = path[stepIndex + 1];
		const matched = consumeStepOptionsUntilToken(
			argv,
			bodyStartIndex,
			current.options,
			next.token,
			ctx
		);
		if (!matched) return false;
		ignored.add(matched.tokenIndex);
		for (const optionIndex of matched.ignoredOptionIndexes) ignored.add(optionIndex);
		bodyStartIndex = matched.tokenIndex + 1;
	}

	const positionals: string[] = [];
	let afterDoubleDash = false;
	const finalOptions = path[path.length - 1].options;
	for (let i = bodyStartIndex; i < argv.length; i++) {
		if (ignored.has(i)) continue;
		const tok = argv[i];
		if (typeof tok !== 'string') return false;
		if (afterDoubleDash) {
			positionals.push(tok);
			continue;
		}
		if (tok === '--') {
			afterDoubleDash = true;
			continue;
		}
		if (looksLikeShellOptionToken(tok)) {
			if (matchesDeniedOption(tok, finalOptions?.deny)) return false;
			if (finalOptions?.allow) {
				const matched = matchShellOptionToken(tok, argv[i + 1], finalOptions.allow);
				if (!matched) return false;
				if (!optionSpecMatchesValue(matched.spec, matched.value, ctx)) return false;
				if (matched.spec.kind === 'flag' && matched.spec.name === '--') {
					afterDoubleDash = true;
				}
				if (matched.consumedNextToken) i += 1;
				continue;
			}
			continue;
		}
		positionals.push(tok);
	}

	return positionalsMatch(positionalsRule, positionals, ctx);
}

function optionSpecMatchesValue(
	spec: ShellOptionSpec,
	value: string | undefined,
	ctx: ShellMatchContext
): boolean {
	if (spec.kind === 'flag') return true;
	if (value === undefined) return false;
	switch (spec.value.kind) {
		case 'any':
			return true;
		case 'workspace-path':
			return !!ctx.workspaceRoot && isPathInWorkspace(value, ctx.workspaceRoot);
	}
}

function consumeStepOptionsUntilToken(
	argv: string[],
	startIndex: number,
	options: ShellOptionRules | undefined,
	nextToken: string,
	ctx: ShellMatchContext
): { tokenIndex: number; ignoredOptionIndexes: number[] } | null {
	const ignoredOptionIndexes: number[] = [];
	for (let i = startIndex; i < argv.length; ) {
		const tok = argv[i];
		if (tok === nextToken) return { tokenIndex: i, ignoredOptionIndexes };
		if (tok === '--' || !looksLikeShellOptionToken(tok)) return null;
		if (matchesDeniedOption(tok, options?.deny)) return null;
		if (!options?.allow) return null;
		const matched = matchShellOptionToken(tok, argv[i + 1], options.allow);
		if (!matched) return null;
		if (!optionSpecMatchesValue(matched.spec, matched.value, ctx)) return null;
		ignoredOptionIndexes.push(i);
		if (matched.consumedNextToken) {
			ignoredOptionIndexes.push(i + 1);
			i += 2;
		} else {
			i += 1;
		}
	}
	return null;
}

function matchesDeniedOption(tok: string, denied: readonly string[] | undefined): boolean {
	if (!denied) return false;
	for (const name of denied) {
		if (tok === name || tok.startsWith(name + '=')) return true;
		if (/^-[^-]$/.test(name) && tok.startsWith(name)) return true;
	}
	return false;
}

function positionalsMatch(
	rule: PositionalsRule | undefined,
	positionals: string[],
	ctx: ShellMatchContext
): boolean {
	if (!rule) return true;
	switch (rule.kind) {
		case 'any':
			return true;
		case 'none':
			return positionals.length === 0;
		case 'workspace-paths': {
			if (!ctx.workspaceRoot) return false;
			for (const p of positionals) {
				if (!isPathInWorkspace(p, ctx.workspaceRoot)) return false;
			}
			return true;
		}
		case 'session-workspace-paths': {
			if (!ctx.sessionWorkspaceRoot) return false;
			for (const p of positionals) {
				if (!isPathInWorkspace(p, ctx.sessionWorkspaceRoot)) return false;
			}
			return true;
		}
	}
}
