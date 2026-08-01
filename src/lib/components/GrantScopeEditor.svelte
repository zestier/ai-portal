<script lang="ts">
	import { untrack } from 'svelte';
	import { decodeScope } from '$lib/permissions/scope-codec';
	import type { GrantScope, ShellCommandStep } from '$lib/permissions/scope-types';
	import type { GrantTool } from '$lib/permissions/metadata';
	import {
		buildGrantScopeJson,
		grantScopeToFormFields,
		nextShellStepOptions,
		shellCommandTokens as deriveShellCommandTokens,
		type FsBehaviorKind,
		type GrantScopeFormFields,
		type ShellPipelineKind,
		type ShellPositionalsKind,
		type ShellStepOptionInput,
		type UrlRuleKind
	} from '$lib/permissions/grant-form';
	import PermissionGrantScopeFields from './PermissionGrantScopeFields.svelte';

	// Self-contained editor for a structured permission-grant scope. It owns the
	// `GrantScopeFormFields` state, the shell-step bookkeeping, and the
	// build/decode of the edited scope, rendering the shared
	// `PermissionGrantScopeFields` form. Both the settings page and the in-chat
	// grant-request dialog drive it so the two stay in lockstep.
	//
	// Seeding: pass `seedScope` for the initial value and bump `seedEpoch`
	// whenever the parent wants to (re)load a scope into the form — e.g. when the
	// settings page starts editing an existing grant or resets the form. The
	// build result is surfaced through the bindable `scopeJson` / `scope` /
	// `error` outputs.
	// Result of building the current form into a structured scope. `json` is ''
	// (and `scope` null) while the form is incomplete/invalid; `error` carries
	// the validation message in that case.
	interface GrantScopeEditorResult {
		json: string;
		scope: GrantScope | null;
		error: string | null;
	}

	let {
		tool,
		seedScope = null,
		seedEpoch = 0,
		onChange
	}: {
		tool: GrantTool;
		seedScope?: GrantScope | null;
		seedEpoch?: number;
		/** Emitted whenever the edited scope (re)builds. One-way data out. */
		onChange?: (result: GrantScopeEditorResult) => void;
	} = $props();

	const initial = untrack(() => grantScopeToFormFields(seedScope));

	let shellArgv0 = $state(initial.fields.shellArgv0);
	let shellSubcommands = $state(initial.fields.shellSubcommands);
	let shellPositionals = $state<ShellPositionalsKind>(initial.fields.shellPositionals);
	let shellPositionalMin = $state(initial.fields.shellPositionalMin);
	let shellPositionalMax = $state(initial.fields.shellPositionalMax);
	let shellPipeline = $state<ShellPipelineKind>(initial.fields.shellPipeline);
	let shellStepOptions = $state<ShellStepOptionInput[]>(initial.fields.shellStepOptions);
	let originalShellCommand = $state<ShellCommandStep[] | null>(initial.originalShellCommand);

	let fsRoot = $state<GrantScopeFormFields['fsRoot']>(initial.fields.fsRoot);
	let fsBehavior = $state<FsBehaviorKind>(initial.fields.fsBehavior);
	let fsValue = $state(initial.fields.fsValue);

	let urlRuleKind = $state<UrlRuleKind>(initial.fields.urlRuleKind);
	let urlExact = $state(initial.fields.urlExact);
	let urlHost = $state(initial.fields.urlHost);
	let urlSuffix = $state(initial.fields.urlSuffix);

	let lastSeedEpoch = $state(untrack(() => seedEpoch));

	function currentFields(): GrantScopeFormFields {
		return {
			shellArgv0,
			shellSubcommands,
			shellPositionals,
			shellPositionalMin,
			shellPositionalMax,
			shellPipeline,
			shellStepOptions,
			fsRoot,
			fsBehavior,
			fsValue,
			urlRuleKind,
			urlExact,
			urlHost,
			urlSuffix
		};
	}

	function applyFields(fields: GrantScopeFormFields) {
		shellArgv0 = fields.shellArgv0;
		shellSubcommands = fields.shellSubcommands;
		shellPositionals = fields.shellPositionals;
		shellPositionalMin = fields.shellPositionalMin;
		shellPositionalMax = fields.shellPositionalMax;
		shellPipeline = fields.shellPipeline;
		shellStepOptions = fields.shellStepOptions;
		fsRoot = fields.fsRoot;
		fsBehavior = fields.fsBehavior;
		fsValue = fields.fsValue;
		urlRuleKind = fields.urlRuleKind;
		urlExact = fields.urlExact;
		urlHost = fields.urlHost;
		urlSuffix = fields.urlSuffix;
	}

	// Re-seed the form whenever the parent bumps `seedEpoch`. Reading the scope
	// untracked keeps this effect keyed purely on the epoch so it doesn't also
	// fire while the user edits the live form.
	$effect(() => {
		if (seedEpoch === lastSeedEpoch) return;
		lastSeedEpoch = seedEpoch;
		const next = untrack(() => grantScopeToFormFields(seedScope));
		applyFields(next.fields);
		originalShellCommand = next.originalShellCommand;
	});

	const shellCommandTokens = $derived(deriveShellCommandTokens({ shellArgv0, shellSubcommands }));

	$effect(() => {
		const next = nextShellStepOptions(shellCommandTokens, shellStepOptions, originalShellCommand);
		const changed =
			next.length !== shellStepOptions.length ||
			next.some((entry, i) => entry !== shellStepOptions[i]);
		if (changed) shellStepOptions = next;
	});

	// `behavior: 'any'` is invalid for the `absolute` root (the matcher needs a
	// concrete value), so coerce to `exact` the moment the user selects it.
	$effect(() => {
		if (fsRoot === 'absolute' && fsBehavior === 'any') {
			fsBehavior = 'exact';
		}
	});

	function updateShellStepOption(index: number, field: keyof ShellStepOptionInput, value: string) {
		shellStepOptions = shellStepOptions.map((entry, i) =>
			i === index ? { ...entry, [field]: value } : entry
		);
	}

	$effect(() => {
		const result = buildGrantScopeJson(tool, currentFields());
		const json = result.json ?? '';
		onChange?.({
			json,
			scope: result.json ? decodeScope(result.json) : null,
			error: result.error
		});
	});
</script>

<PermissionGrantScopeFields
	{tool}
	{shellCommandTokens}
	bind:shellArgv0
	bind:shellSubcommands
	bind:shellPositionals
	bind:shellPositionalMin
	bind:shellPositionalMax
	bind:shellPipeline
	bind:shellStepOptions
	bind:fsRoot
	bind:fsBehavior
	bind:fsValue
	bind:urlRuleKind
	bind:urlExact
	bind:urlHost
	bind:urlSuffix
	{updateShellStepOption}
/>
