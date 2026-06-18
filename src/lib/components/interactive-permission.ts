import { deriveScopeKey } from '$lib/permissions/scope-key';
import { isFilesystemPermissionKind } from '$lib/permissions/metadata';
import { resolveSubcommandIndex } from '$lib/permissions/shell-argv';
import type { GrantScope } from '$lib/permissions/scope-types';
import type {
	InteractivePermissionView,
	PermissionGrantScope,
	ShellAnalysisSegment
} from '$lib/types';

export type ScopeChoice = 'this-exact' | 'this-directory' | 'tool-kind' | 'tool-any' | 'everything';

/** The persistent-grant TTL options offered by the permission dialogs. */
export type ExpiryChoice = 'forever' | '1h' | '1d';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Map an {@link ExpiryChoice} to a TTL in milliseconds for an *-always grant.
 * `forever` (and any unknown value) yields `undefined` — "never expires" —
 * matching the `expiresInMs` contract on the permission `InteractiveResponse`.
 */
export function expiryChoiceToMs(choice: ExpiryChoice): number | undefined {
	switch (choice) {
		case '1h':
			return HOUR_MS;
		case '1d':
			return DAY_MS;
		case 'forever':
		default:
			return undefined;
	}
}

export interface PermissionScopeContext {
	isFsKind: boolean;
	scopeKey: string | null;
	fsParentDir: string | null;
	choices: ScopeChoice[];
}

export interface ShellScopeOption {
	id: string;
	label: string;
	summary: string;
	scope: GrantScope;
}

const SUBCOMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9_.:+-]*$/;

export function buildPermissionScopeContext(
	request: InteractivePermissionView
): PermissionScopeContext {
	const isFsKind = isFilesystemPermissionKind(request.permissionKind);
	const scopeKey =
		deriveScopeKey(request.permissionKind, {
			fullCommandText: undefined,
			fileName: undefined,
			args: request.args
		}) ?? deriveFromSummary(request);
	return {
		isFsKind,
		scopeKey,
		fsParentDir: isFsKind && scopeKey ? parentDirOf(scopeKey) : null,
		choices: isFsKind
			? ['this-exact', 'this-directory']
			: ['this-exact', 'tool-kind', 'tool-any', 'everything']
	};
}

export function defaultScopeChoice(ctx: PermissionScopeContext): ScopeChoice {
	if (ctx.isFsKind) return ctx.scopeKey ? 'this-exact' : 'this-directory';
	return ctx.scopeKey ? 'this-exact' : 'tool-kind';
}

export function buildPermissionGrantScope(
	request: InteractivePermissionView,
	ctx: PermissionScopeContext,
	choice: ScopeChoice
): PermissionGrantScope | undefined {
	const kind = request.permissionKind;
	switch (choice) {
		case 'this-exact':
			if (ctx.isFsKind && ctx.scopeKey && isFilesystemPermissionKind(kind)) {
				return {
					permissionKind: kind,
					scope: {
						kind: 'fs',
						perms: [kind],
						rule: { kind: 'path', root: 'absolute', behavior: 'exact', value: ctx.scopeKey }
					}
				};
			}
			return ctx.scopeKey
				? { permissionKind: kind, pattern: ctx.scopeKey }
				: { permissionKind: kind, pattern: null };
		case 'this-directory':
			if (!ctx.fsParentDir) {
				return ctx.scopeKey
					? { permissionKind: kind, pattern: ctx.scopeKey }
					: { permissionKind: kind, pattern: null };
			}
			if (!isFilesystemPermissionKind(kind)) return { permissionKind: kind, pattern: null };
			return {
				permissionKind: kind,
				scope: {
					kind: 'fs',
					perms: [kind],
					rule: { kind: 'path', root: 'absolute', behavior: 'prefix', value: ctx.fsParentDir }
				}
			};
		case 'tool-kind':
			return { permissionKind: kind, pattern: null };
		case 'tool-any':
			return { permissionKind: null, pattern: null };
		case 'everything':
			return undefined;
	}
}

export function scopeOptionLabel(
	request: InteractivePermissionView,
	ctx: PermissionScopeContext,
	choice: ScopeChoice
): string {
	const tool = request.tool;
	const kind = request.permissionKind;
	switch (choice) {
		case 'this-exact':
			return ctx.scopeKey
				? `Just this exact ${kind || 'request'}`
				: `Just this exact ${kind || 'request'} (unavailable)`;
		case 'this-directory':
			return ctx.fsParentDir
				? `Anywhere under \`${ctx.fsParentDir}/\``
				: `Anywhere under this directory (unavailable)`;
		case 'tool-kind':
			return `Any ${tool} (${kind}) request`;
		case 'tool-any':
			return `Any ${tool} request, regardless of kind`;
		case 'everything':
			return `Any request from this tool, regardless of kind or arguments (broadest)`;
	}
}

export function previewPersistentPermission(
	request: InteractivePermissionView,
	ctx: PermissionScopeContext,
	choice: ScopeChoice,
	decision: 'allow-always' | 'deny-always',
	appliesTo: 'this-conversation' | 'all-conversations',
	expiryChoice: ExpiryChoice
): string {
	const verb = decision === 'allow-always' ? 'Allow' : 'Deny';
	const tool = request.tool;
	const kind = request.permissionKind;
	const where =
		appliesTo === 'all-conversations' ? 'in every conversation' : 'in this conversation';
	const ttl =
		expiryChoice === '1h' ? ', for 1 hour' : expiryChoice === '1d' ? ', for 1 day' : ', forever';
	let what: string;
	switch (choice) {
		case 'this-exact':
			what = ctx.scopeKey
				? `${tool} (${kind}) matching \`${ctx.scopeKey}\``
				: `${tool} (${kind}) for any arguments`;
			break;
		case 'this-directory':
			what = ctx.fsParentDir
				? `${tool} (${kind}) under \`${ctx.fsParentDir}/\``
				: `${tool} (${kind}) under this directory`;
			break;
		case 'tool-kind':
			what = `any ${tool} (${kind}) request`;
			break;
		case 'tool-any':
			what = `any ${tool} request, regardless of kind`;
			break;
		case 'everything':
			what = `any request from ${tool}`;
			break;
	}
	return `${verb} ${what} ${where}${ttl}.`;
}

export function buildShellOptions(segments: ShellAnalysisSegment[]): ShellScopeOption[] {
	const out: ShellScopeOption[] = [];
	const seenArgv0 = new Set<string>();
	const seenSub = new Set<string>();
	for (const seg of segments) {
		const argv0 = seg.argv[0];
		if (typeof argv0 !== 'string' || argv0.length === 0) continue;
		if (argv0.includes('/') || argv0.startsWith('.')) continue;
		if (!seenArgv0.has(argv0)) {
			seenArgv0.add(argv0);
			out.push({
				id: `argv0:${argv0}`,
				label: `Any \`${argv0}\` command (any subcommand, any args)`,
				summary: `any \`${argv0}\` invocation`,
				scope: {
					kind: 'shell',
					rule: { command: [{ token: argv0 }], positionals: { kind: 'any' } }
				}
			});
		}
		const subIndex = resolveSubcommandIndex(seg.argv, []).subcommandIndex;
		const sub = subIndex === null ? undefined : seg.argv[subIndex];
		if (
			typeof sub === 'string' &&
			!sub.startsWith('-') &&
			SUBCOMMAND_RE.test(sub) &&
			!seenSub.has(`${argv0} ${sub}`)
		) {
			seenSub.add(`${argv0} ${sub}`);
			out.push({
				id: `sub:${argv0}:${sub}`,
				label: `Any \`${argv0} ${sub}\` command (any args)`,
				summary: `any \`${argv0} ${sub}\` invocation`,
				scope: {
					kind: 'shell',
					rule: {
						command: [{ token: argv0 }, { token: sub }],
						positionals: { kind: 'any' }
					}
				}
			});
		}
	}
	return out;
}

export function operatorGloss(op: ShellAnalysisSegment['followingOp']): string {
	switch (op) {
		case '&&':
			return 'then (only if previous succeeded)';
		case '||':
			return 'then (only if previous failed)';
		case ';':
			return 'then (regardless)';
		case '|':
			return 'piped to';
		default:
			return '';
	}
}

function parentDirOf(p: string): string | null {
	if (!p || !p.startsWith('/')) return null;
	const i = p.lastIndexOf('/');
	if (i <= 0) return '/';
	return p.slice(0, i);
}

function deriveFromSummary(req: InteractivePermissionView): string | null {
	const s = typeof req.summary === 'string' ? req.summary.trim() : '';
	return s.length > 0 && s !== req.tool ? s : null;
}
