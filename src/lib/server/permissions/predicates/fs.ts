// Predicate for FsScope grants — `read` / `write` / `edit` requests.

import { isAbsolute, sep, relative, resolve } from 'node:path';
import type { FsScope, FsRule } from '../../../permissions/scope-types';
import { isPathInWorkspace, resolveWithParentFallback } from '../workspace';

export interface FsMatchContext {
	permissionKind: 'read' | 'write' | 'edit';
	target: string;
	workspaceRoot: string | null;
	sessionWorkspaceRoot?: string | null;
}

export function fsScopeMatches(scope: FsScope, ctx: FsMatchContext): boolean {
	if (scope.perms && scope.perms.length > 0 && !scope.perms.includes(ctx.permissionKind)) {
		return false;
	}
	return fsRuleMatches(scope.rule, ctx);
}

function fsRuleMatches(rule: FsRule, ctx: FsMatchContext): boolean {
	switch (rule.kind) {
		case 'path':
			return pathRuleMatches(rule, ctx);
	}
}

function pathRuleMatches(rule: FsRule, ctx: FsMatchContext): boolean {
	if (ctx.target.includes('\0')) return false;
	if (rule.root === 'absolute') {
		const target = canonicalAbsolutePath(ctx.target);
		if (target === null) return false;
		return absolutePathBehaviorMatches(rule.behavior, rule.value, target);
	}

	const root = rule.root === 'workspace' ? ctx.workspaceRoot : ctx.sessionWorkspaceRoot;
	if (!root) return false;
	const rel = canonicalRelativePath(ctx.target, root);
	if (rel === null) return false;
	if (rule.behavior === 'any') return true;
	return relativePathBehaviorMatches(rule.behavior, rule.value, rel);
}

function absolutePathBehaviorMatches(
	behavior: 'exact' | 'prefix' | 'glob',
	value: string,
	target: string
): boolean {
	if (value.includes('\0') || target.includes('\0')) return false;
	switch (behavior) {
		case 'exact': {
			const exact = canonicalAbsolutePath(value);
			return exact !== null && target === exact;
		}
		case 'prefix':
			return prefixMatches(value, target);
		case 'glob':
			return tokenGlobMatches(value, target);
	}
}

function relativePathBehaviorMatches(
	behavior: 'exact' | 'prefix' | 'glob',
	value: string,
	target: string
): boolean {
	if (value.includes('\0') || target.includes('\0')) return false;
	switch (behavior) {
		case 'exact':
			return target === value;
		case 'prefix':
			return relativePrefixMatches(value, target);
		case 'glob':
			return tokenGlobMatches(value, target);
	}
}

function canonicalAbsolutePath(path: string): string | null {
	if (!path || path.includes('\0') || !isAbsolute(path)) return null;
	return resolveWithParentFallback(resolve(path));
}

/**
 * True when `target` is `prefix` itself or lives inside it, after
 * resolving symlinks on both sides (with parent-fallback for paths
 * that don't exist yet). Both arguments must be absolute; relative
 * inputs fail closed because the prefix wouldn't have a stable
 * meaning across working directories.
 */
function prefixMatches(prefix: string, target: string): boolean {
	if (!prefix || !target) return false;
	if (prefix.includes('\0') || target.includes('\0')) return false;
	if (!isAbsolute(prefix) || !isAbsolute(target)) return false;
	const resolvedPrefix = resolveWithParentFallback(prefix);
	const resolvedTarget = resolveWithParentFallback(target);
	if (resolvedPrefix === null || resolvedTarget === null) return false;
	if (resolvedTarget === resolvedPrefix) return true;
	const rel = relative(resolvedPrefix, resolvedTarget);
	if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
	return resolvedTarget.startsWith(resolvedPrefix + sep);
}

function relativePrefixMatches(prefix: string, target: string): boolean {
	if (!prefix || !target) return false;
	if (prefix.includes('\0') || target.includes('\0')) return false;
	if (isAbsolute(prefix) || isAbsolute(target)) return false;
	if (target === prefix) return true;
	const rel = relative(prefix, target);
	if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
	return target.startsWith(prefix.replace(/\/$/, '') + '/');
}

function canonicalRelativePath(target: string, root: string): string | null {
	if (!isPathInWorkspace(target, root)) return null;

	const resolvedRoot = canonicalAbsolutePath(resolve(root));
	if (resolvedRoot === null) return null;
	const absTarget = isAbsolute(target) ? resolve(target) : resolve(resolvedRoot, target);
	const resolvedTarget = resolveWithParentFallback(absTarget);
	if (resolvedTarget === null) return null;
	if (resolvedTarget === resolvedRoot) return '';

	const rel = relative(resolvedRoot, resolvedTarget);
	if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
	if (!resolvedTarget.startsWith(resolvedRoot + sep)) return null;
	return rel;
}

/**
 * Token-aware glob over `/`-separated paths:
 *   `*`  matches characters within a single segment
 *   `**` matches any number of full segments (including zero) when it begins
 *        the pattern or immediately follows `/`; otherwise (e.g. `project**`)
 *        it is treated as a single-segment `*` and does not cross `/`
 * Everything else is literal.
 */
export function tokenGlobMatches(glob: string, path: string): boolean {
	return globToRegex(glob).test(path);
}

function globToRegex(glob: string): RegExp {
	let re = '^';
	let i = 0;
	while (i < glob.length) {
		const ch = glob[i];
		if (ch === '*') {
			if (glob[i + 1] === '*') {
				if (glob[i + 2] === '/') {
					re += '(?:.*/)?';
					i += 3;
				} else if (i === 0 || glob[i - 1] === '/') {
					re += '.*';
					i += 2;
				} else {
					re += '[^/]*';
					i += 2;
				}
			} else {
				re += '[^/]*';
				i += 1;
			}
		} else {
			re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
			i += 1;
		}
	}
	re += '$';
	return new RegExp(re);
}
