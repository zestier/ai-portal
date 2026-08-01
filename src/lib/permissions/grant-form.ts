import {
	FS_RULE_BEHAVIORS_WITH_VALUE,
	type FsRuleBehaviorWithValue,
	type FsRuleRoot,
	type GrantScope,
	type ShellCommandStep,
	type ShellOptionRules,
	type ShellOptionSpec
} from './scope-types';
import type { GrantTool } from './metadata';

export type ShellPositionalsKind =
	| 'unset'
	| 'none'
	| 'any'
	| 'pattern-only'
	| 'workspace-paths'
	| 'session-workspace-paths';
export type ShellPipelineKind = 'unset' | 'must' | 'forbid' | 'pipe-target';
export type FsBehaviorKind = 'any' | FsRuleBehaviorWithValue;
export type UrlRuleKind = 'exact' | 'host' | 'host-suffix';
export type BuildResult = { json: string; error: null } | { json: null; error: string };
export type ShellStepOptionInput = { allow: string; deny: string };

export interface GrantScopeFormFields {
	shellArgv0: string;
	shellSubcommands: string;
	shellPositionals: ShellPositionalsKind;
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

function buildShellScopeJson(fields: GrantScopeFormFields): BuildResult {
	if (!fields.shellArgv0.trim()) return { json: null, error: 'argv0 is required' };
	const command: ShellCommandStep[] = shellCommandTokens(fields).map((token) => ({ token }));
	const rule: Record<string, unknown> = { command };
	if (fields.shellPositionals !== 'unset') rule.positionals = { kind: fields.shellPositionals };
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
