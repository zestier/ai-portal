<script lang="ts">
	import { FS_RULE_BEHAVIORS_WITH_VALUE, FS_RULE_ROOTS } from '$lib/permissions/scope-types';
	import {
		fsBehaviorLabel,
		fsRootLabel,
		type ShellStepOptionInput
	} from '$lib/permissions/grant-form';
	import type { GrantTool } from '$lib/permissions/metadata';
	import type {
		FsBehaviorKind,
		GrantScopeFormFields,
		ShellPipelineKind,
		ShellPositionalsKind,
		UrlRuleKind
	} from '$lib/permissions/grant-form';

	let {
		tool,
		shellCommandTokens,
		shellArgv0 = $bindable(),
		shellSubcommands = $bindable(),
		shellPositionals = $bindable(),
		shellPipeline = $bindable(),
		shellStepOptions = $bindable(),
		fsRoot = $bindable(),
		fsBehavior = $bindable(),
		fsValue = $bindable(),
		urlRuleKind = $bindable(),
		urlExact = $bindable(),
		urlHost = $bindable(),
		urlSuffix = $bindable(),
		updateShellStepOption
	}: {
		tool: GrantTool;
		shellCommandTokens: string[];
		shellArgv0: string;
		shellSubcommands: string;
		shellPositionals: ShellPositionalsKind;
		shellPipeline: ShellPipelineKind;
		shellStepOptions: ShellStepOptionInput[];
		fsRoot: GrantScopeFormFields['fsRoot'];
		fsBehavior: FsBehaviorKind;
		fsValue: string;
		urlRuleKind: UrlRuleKind;
		urlExact: string;
		urlHost: string;
		urlSuffix: string;
		updateShellStepOption: (
			index: number,
			field: keyof ShellStepOptionInput,
			value: string
		) => void;
	} = $props();
</script>

{#if tool === 'shell'}
	<fieldset class="scope-fields">
		<legend>Shell scope</legend>
		<label>
			argv0 (the bare command name)
			<input
				type="text"
				bind:value={shellArgv0}
				placeholder="cd"
				spellcheck="false"
				autocomplete="off"
			/>
			<span class="muted small">No slashes, no leading dot — just the program name.</span>
		</label>
		<label>
			Subcommand path (optional, space-separated)
			<input
				type="text"
				bind:value={shellSubcommands}
				placeholder="remote set-url"
				spellcheck="false"
				autocomplete="off"
			/>
			<span class="muted small"
				>Each token extends the command path. Options can be configured for every command step
				below.</span
			>
		</label>
		<label>
			Positional arguments
			<select bind:value={shellPositionals}>
				<option value="unset">(unconstrained — any positionals)</option>
				<option value="none">none (the command takes no positional args)</option>
				<option value="any">any (positionals are anything)</option>
				<option value="workspace-paths"
					>workspace-paths (every positional must resolve inside the conversation's workspace)</option
				>
				<option value="session-workspace-paths"
					>session-workspace-paths (every positional must resolve inside the SDK session workspace)</option
				>
			</select>
		</label>
		<label>
			Pipeline constraint
			<select bind:value={shellPipeline}>
				<option value="unset">(no constraint — matches regardless of `|` neighbours)</option>
				<option value="must"
					>must — only matches when the command is part of a pipeline (`a | b`)</option
				>
				<option value="forbid">forbid — only matches when the command is NOT pipelined</option>
			</select>
			<span class="muted small"
				>Useful for deny grants that nudge toward structured alternatives: `pipeline=forbid` lets
				`cmd | grep ...` keep working while rejecting bare `grep`.</span
			>
		</label>
		<div class="step-options">
			<p class="muted small">
				Option-spec syntax: bare names are boolean flags; `name=any` and `name=workspace-path`
				consume a value (`name value` or `name=value`). Options on a non-final step are consumed
				before matching the next command token; options on the final step may be interleaved with
				positionals.
			</p>
			{#each shellCommandTokens as token, i}
				<fieldset class="step-option-fields">
					<legend>
						Options after `{token || '(argv0)'}`
						{#if i === 0}
							<span class="muted">(base command)</span>
						{:else if i === shellCommandTokens.length - 1}
							<span class="muted">(final step)</span>
						{:else}
							<span class="muted">(intermediate step)</span>
						{/if}
					</legend>
					<label>
						Allow list (optional, comma-separated)
						<input
							type="text"
							value={shellStepOptions[i]?.allow ?? ''}
							oninput={(e) => updateShellStepOption(i, 'allow', e.currentTarget.value)}
							placeholder={i === 0 ? '--no-pager, -C=any' : '-v, --format=any'}
							spellcheck="false"
							autocomplete="off"
						/>
					</label>
					<label>
						Deny list (optional, comma-separated)
						<input
							type="text"
							value={shellStepOptions[i]?.deny ?? ''}
							oninput={(e) => updateShellStepOption(i, 'deny', e.currentTarget.value)}
							placeholder={i === 0 ? '--git-dir, -C' : '--upload-pack'}
							spellcheck="false"
							autocomplete="off"
						/>
					</label>
				</fieldset>
			{/each}
		</div>
	</fieldset>
{:else if tool === 'url'}
	<fieldset class="scope-fields">
		<legend>URL scope</legend>
		<label>
			Match by
			<select bind:value={urlRuleKind}>
				<option value="exact">exact URL</option>
				<option value="host">exact host</option>
				<option value="host-suffix">host suffix (e.g. *.github.com)</option>
			</select>
		</label>
		{#if urlRuleKind === 'exact'}
			<label>
				URL
				<input
					type="url"
					bind:value={urlExact}
					placeholder="https://api.github.com/users/octocat"
					autocomplete="off"
				/>
			</label>
		{:else if urlRuleKind === 'host'}
			<label>
				Host
				<input type="text" bind:value={urlHost} placeholder="api.github.com" autocomplete="off" />
			</label>
		{:else}
			<label>
				Suffix
				<input type="text" bind:value={urlSuffix} placeholder="github.com" autocomplete="off" />
				<span class="muted small"
					>Matches hosts equal to `suffix` or ending with `.suffix` (so `github.com` and
					`api.github.com` both match `github.com`).</span
				>
			</label>
		{/if}
	</fieldset>
{:else}
	<fieldset class="scope-fields">
		<legend>Filesystem scope ({tool})</legend>
		<label>
			Root
			<select bind:value={fsRoot}>
				{#each FS_RULE_ROOTS as root}
					<option value={root}>{fsRootLabel(root)}</option>
				{/each}
			</select>
		</label>
		<label>
			Behavior
			<select bind:value={fsBehavior}>
				{#if fsRoot !== 'absolute'}
					<option value="any">{fsBehaviorLabel('any')}</option>
				{/if}
				{#each FS_RULE_BEHAVIORS_WITH_VALUE as behavior}
					<option value={behavior}>{fsBehaviorLabel(behavior)}</option>
				{/each}
			</select>
		</label>
		{#if fsBehavior !== 'any'}
			<label>
				{fsRoot === 'absolute' ? 'Absolute path or glob' : 'Relative path or glob'}
				<input
					type="text"
					bind:value={fsValue}
					placeholder={fsRoot === 'absolute' ? '/workspaces/project/src/**/*.ts' : 'src/**/*.ts'}
					spellcheck="false"
					autocomplete="off"
				/>
				<span class="muted small"
					>Workspace and session-workspace values are relative to that root. Absolute values start
					with `/`. For glob, `*` matches one path segment and `**` matches any number.</span
				>
			</label>
		{/if}
	</fieldset>
{/if}

<style>
	.scope-fields {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}
	.scope-fields legend {
		padding: 0 0.25rem;
		font-size: var(--fs-md);
		color: var(--muted, #888);
	}
	.scope-fields label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		min-width: 0;
	}
	.scope-fields input,
	.scope-fields select {
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
	}
	.step-options {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}
	.step-option-fields {
		border: 1px dashed var(--border);
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
		gap: 0.75rem;
		min-width: 0;
	}
	.step-option-fields legend {
		grid-column: 1 / -1;
	}
	.small {
		font-size: var(--fs-md);
	}
</style>
