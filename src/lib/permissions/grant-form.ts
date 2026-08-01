import {
	FS_RULE_BEHAVIORS_WITH_VALUE,
	type FsRuleBehaviorWithValue,
	type FsRuleRoot,
	type GrantScope,
	type PositionalsRule,
	type ShellCommandStep,
	type ShellOptionRules,
	type ShellOptionSpec
} from './scope-types';
import type { GrantTool } from './metadata';

export type ShellPositionalsKind = 'unset' | PositionalsRule['kind'];
export type ShellPipelineKind = 'unset' | 'must' | 'forbid' | 'pipe-target';
export type FsBehaviorKind = 'any' | FsRuleBehaviorWithValue;
export type UrlRuleKind = 'exact' | 'host' | 'host-suffix';
export type BuildResult = { json: string; error: null } | { json: null; error: string };
export type ShellStepOptionInput = { allow: string; deny: string };

export interface GrantScopeFormFields {
	shellArgv0: string;
	shellSubcommands: string;
	shellPositionals: ShellPositionalsKind;
	shellPositionalMin: string;
	shellPositionalMax: string;
	shellPipeline: ShellPipelineKind;
	shellStepOptions: ShellStepOptionInput[];
	fsRoot: FsRuleRoot;
	fsBehavior: FsBehaviorKind;
	fsValue: string;
	urlRuleKind: UrlRuleKind;
	urlExact: string;
	urlHost: string;
	urlSuffix: string;
}

export function defaultGrantScopeFormFields(): GrantScopeFormFields {
	return {
		shellArgv0: '',
		shellSubcommands: '',
		shellPositionals: 'unset',
		shellPositionalMin: '',
		shellPositionalMax: '',
		shellPipeline: 'unset',
		shellStepOptions: [{ allow: '', deny: '' }],
		fsRoot: 'workspace',
		fsBehavior: 'any',
		fsValue: '',
		urlRuleKind: 'host',
		urlExact: '',
		urlHost: '',
		urlSuffix: ''
	};
}

export function csvToList(s: string): string[] {
	return s
		.split(',')
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
}

export function parseShellOptionSpecs(input: string): ShellOptionSpec[] {
	return csvToList(input).map((entry) => {
		const split = entry.indexOf('=');
		if (split === -1) {
			if (!entry.startsWith('-')) {
				throw new Error(`option name "${entry}" must start with '-'`);
			}
			return { name: entry, kind: 'flag' };
		}
		const name = entry.slice(0, split).trim();
		const valueKind = entry.slice(split + 1).trim();
		if (!name.startsWith('-')) {
			throw new Error(`option name "${name}" must start with '-'`);
		}
		if (valueKind !== 'any' && valueKind !== 'workspace-path') {
			throw new Error(`option "${name}" must end with =any or =workspace-path`);
		}
		const valueRule =
			valueKind === 'any' ? ({ kind: 'any' } as const) : ({ kind: 'workspace-path' } as const);
		return {
			name,
			kind: 'option',
			value: valueRule
		};
	});
}

export function shellOptionSpecsToCsv(specs: ShellOptionSpec[]): string {
	return specs
		.map((spec) => (spec.kind === 'flag' ? spec.name : `${spec.name}=${spec.value.kind}`))
		.join(', ');
}

export function commandTailToText(command: ShellCommandStep[] | undefined): string {
	return (command ?? [])
		.slice(1)
		.map((step) => step.token)
		.join(' ');
}

export function fsRootLabel(root: FsRuleRoot): string {
	const labels = {
		workspace: 'workspace',
		'session-workspace': 'SDK session workspace',
		absolute: 'absolute path'
	} satisfies Record<FsRuleRoot, string>;
	return labels[root];
}

export function fsBehaviorLabel(behavior: FsBehaviorKind): string {
	const labels = {
		any: 'any path inside the root',
		exact: 'one exact path',
		prefix: 'path or anything inside it',
		glob: 'path matching a glob'
	} satisfies Record<FsBehaviorKind, string>;
	return labels[behavior];
}

export function buildGrantScopeJson(tool: GrantTool, fields: GrantScopeFormFields): BuildResult {
	try {
		if (tool === 'shell') return buildShellScopeJson(fields);
		if (tool === 'url') return buildUrlScopeJson(fields);
		return buildFsScopeJson(tool, fields);
	} catch (e) {
		return { json: null, error: e instanceof Error ? e.message : String(e) };
	}
}

export function grantScopeToFormFields(scope: GrantScope | null): {
	fields: GrantScopeFormFields;
	originalShellCommand: ShellCommandStep[] | null;
} {
	const fields = defaultGrantScopeFormFields();
	let originalShellCommand: ShellCommandStep[] | null = null;
	if (!scope) return { fields, originalShellCommand };
	switch (scope.kind) {
		case 'shell':
			originalShellCommand = scope.rule.command;
			fields.shellArgv0 = scope.rule.command[0]?.token ?? '';
			fields.shellSubcommands = commandTailToText(scope.rule.command);
			fields.shellPositionals = scope.rule.positionals?.kind ?? 'unset';
			fields.shellPositionalMin = countBoundToText(scope.rule.positionalCount?.min);
			fields.shellPositionalMax = countBoundToText(scope.rule.positionalCount?.max);
			fields.shellPipeline = scope.rule.pipeline ?? 'unset';
			fields.shellStepOptions = scope.rule.command.map((step) => ({
				allow: shellOptionSpecsToCsv(step.options?.allow ?? []),
				deny: (step.options?.deny ?? []).join(', ')
			}));
			break;
		case 'url':
			fields.urlRuleKind = scope.rule.kind;
			if (scope.rule.kind === 'exact') fields.urlExact = scope.rule.url;
			else if (scope.rule.kind === 'host') fields.urlHost = scope.rule.host;
			else fields.urlSuffix = scope.rule.suffix;
			break;
		case 'fs':
			fields.fsRoot = scope.rule.root;
			fields.fsBehavior = scope.rule.behavior;
			fields.fsValue = 'value' in scope.rule ? scope.rule.value : '';
			break;
		case 'any':
			break;
	}
	return { fields, originalShellCommand };
}

export function nextShellStepOptions(
	tokens: string[],
	current: ShellStepOptionInput[],
	originalShellCommand: ShellCommandStep[] | null
): ShellStepOptionInput[] {
	const next = tokens.map((token, i) => {
		const existing = current[i];
		if (existing) return existing;
		const original = originalShellCommand?.[i];
		if (original?.token === token) {
			return {
				allow: shellOptionSpecsToCsv(original.options?.allow ?? []),
				deny: (original.options?.deny ?? []).join(', ')
			};
		}
		return { allow: '', deny: '' };
	});
	return next.length > 0 ? next : [{ allow: '', deny: '' }];
}

function countBoundToText(v: number | undefined): string {
	return v === undefined ? '' : String(v);
}

/**
 * Parse the two count inputs into a `positionalCount` rule. Blank means
 * unconstrained on that end; blank on both ends omits the rule entirely.
 */
function parseCountBounds(fields: GrantScopeFormFields): {
	value: { min?: number; max?: number } | null;
	error: string | null;
} {
	const min = parseCountBound(fields.shellPositionalMin, 'minimum');
	if (min.error) return { value: null, error: min.error };
	const max = parseCountBound(fields.shellPositionalMax, 'maximum');
	if (max.error) return { value: null, error: max.error };
	if (min.value === undefined && max.value === undefined) return { value: null, error: null };
	if (min.value !== undefined && max.value !== undefined && min.value > max.value) {
		return { value: null, error: 'positional count minimum must not exceed the maximum' };
	}
	const value: { min?: number; max?: number } = {};
	if (min.value !== undefined) value.min = min.value;
	if (max.value !== undefined) value.max = max.value;
	return { value, error: null };
}

function parseCountBound(
	raw: string,
	label: string
): { value: number | undefined; error: string | null } {
	// Tolerate a non-string binding (a `type="number"` input yields a number
	// or null) so a stray input type can't throw out of form validation.
	const text = String(raw ?? '').trim();
	if (text === '') return { value: undefined, error: null };
	const n = Number(text);
	if (!Number.isInteger(n) || n < 0) {
		return { value: undefined, error: `positional count ${label} must be a non-negative integer` };
	}
	return { value: n, error: null };
}

function buildShellScopeJson(fields: GrantScopeFormFields): BuildResult {
	if (!fields.shellArgv0.trim()) return { json: null, error: 'argv0 is required' };
	const command: ShellCommandStep[] = shellCommandTokens(fields).map((token) => ({ token }));
	const rule: Record<string, unknown> = { command };
	if (fields.shellPositionals !== 'unset') rule.positionals = { kind: fields.shellPositionals };
	const count = parseCountBounds(fields);
	if (count.error) return { json: null, error: count.error };
	if (count.value) rule.positionalCount = count.value;
	if (fields.shellPipeline !== 'unset') rule.pipeline = fields.shellPipeline;
	for (let i = 0; i < command.length; i++) {
		const allow = parseShellOptionSpecs(fields.shellStepOptions[i]?.allow ?? '');
		const deny = csvToList(fields.shellStepOptions[i]?.deny ?? '');
		if (allow.length === 0 && deny.length === 0) continue;
		const options: ShellOptionRules = {};
		if (allow.length > 0) options.allow = allow;
		if (deny.length > 0) options.deny = deny;
		command[i].options = options;
	}
	return { json: JSON.stringify({ kind: 'shell', rule }), error: null };
}

function buildUrlScopeJson(fields: GrantScopeFormFields): BuildResult {
	const builders = {
		exact: () => {
			if (!fields.urlExact.trim()) return { json: null, error: 'URL is required' } as const;
			return {
				json: JSON.stringify({ kind: 'url', rule: { kind: 'exact', url: fields.urlExact.trim() } }),
				error: null
			} as const;
		},
		host: () => {
			if (!fields.urlHost.trim()) return { json: null, error: 'host is required' } as const;
			return {
				json: JSON.stringify({ kind: 'url', rule: { kind: 'host', host: fields.urlHost.trim() } }),
				error: null
			} as const;
		},
		'host-suffix': () => {
			if (!fields.urlSuffix.trim()) return { json: null, error: 'suffix is required' } as const;
			return {
				json: JSON.stringify({
					kind: 'url',
					rule: { kind: 'host-suffix', suffix: fields.urlSuffix.trim() }
				}),
				error: null
			} as const;
		}
	} satisfies Record<UrlRuleKind, () => BuildResult>;
	return builders[fields.urlRuleKind]();
}

function buildFsScopeJson(tool: Exclude<GrantTool, 'shell' | 'url'>, fields: GrantScopeFormFields) {
	const perms = [tool];
	let rule: Record<string, unknown>;
	if (fields.fsBehavior === 'any') {
		if (fields.fsRoot === 'absolute') {
			return { json: null, error: 'absolute root requires exact, prefix, or glob behavior' };
		}
		rule = { kind: 'path', root: fields.fsRoot, behavior: 'any' };
	} else {
		const value = fields.fsValue.trim();
		if (!value) return { json: null, error: 'path or glob value is required' };
		rule = { kind: 'path', root: fields.fsRoot, behavior: fields.fsBehavior, value };
	}
	return { json: JSON.stringify({ kind: 'fs', perms, rule }), error: null };
}

export function shellCommandTokens(
	fields: Pick<GrantScopeFormFields, 'shellArgv0' | 'shellSubcommands'>
) {
	return [
		fields.shellArgv0.trim(),
		...fields.shellSubcommands
			.split(/\s+/)
			.map((t) => t.trim())
			.filter(Boolean)
	];
}

export function isFsBehaviorWithValue(
	behavior: FsBehaviorKind
): behavior is FsRuleBehaviorWithValue {
	return FS_RULE_BEHAVIORS_WITH_VALUE.includes(behavior as FsRuleBehaviorWithValue);
}
