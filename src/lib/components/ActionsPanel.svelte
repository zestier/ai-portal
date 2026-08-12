<script lang="ts">
	import { onMount } from 'svelte';
	import { streamSse, type StreamSseInit } from '$lib/client/sse';
	import PanelHeader from '$lib/components/ui/PanelHeader.svelte';

	type ActionEvent =
		| { type: 'step'; label: string; cmd: string }
		| { type: 'log'; stream: 'stdout' | 'stderr'; text: string }
		| { type: 'step-done'; label: string; code: number }
		| { type: 'done'; ok: boolean; failedStep?: string; message?: string };

	type ActionInput = {
		name: string;
		label: string;
		type: 'string' | 'enum' | 'number';
		required: boolean;
		default: string | number | null;
		options: string[] | null;
		placeholder: string | null;
	};

	type ActionMeta = {
		id: string;
		label: string;
		description: string | null;
		permission: 'user' | 'admin';
		inputs: ActionInput[];
		commands: string[];
	};

	let { conversationId }: { conversationId: number } = $props();

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let configError = $state<string | null>(null);
	let canRunAdmin = $state(false);
	let actions = $state<ActionMeta[]>([]);
	// Input values keyed `${actionId}::${inputName}`.
	let formValues = $state<Record<string, string>>({});

	let runningId = $state<string | null>(null);
	let runLabel = $state('');
	let runLog = $state('');
	let runStatus = $state<'idle' | 'running' | 'ok' | 'failed'>('idle');
	let logEl = $state<HTMLPreElement | undefined>();

	// Mirror of the server-side `{{NAME}}` token grammar, used only to render a
	// resolved-argv preview in the confirm dialog. The server re-validates and
	// re-substitutes; this is human-visibility, not enforcement.
	const INPUT_TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

	onMount(load);

	function fieldKey(actionId: string, name: string): string {
		return `${actionId}::${name}`;
	}

	async function load() {
		loading = true;
		loadError = null;
		try {
			const res = await fetch(`/api/conversations/${conversationId}/actions`);
			if (!res.ok) throw new Error(`Failed to load actions (${res.status})`);
			const body = await res.json();
			actions = body.actions ?? [];
			canRunAdmin = body.canRunAdmin ?? false;
			configError = body.configError ?? null;
			const init: Record<string, string> = {};
			for (const action of actions) {
				for (const input of action.inputs ?? []) {
					init[fieldKey(action.id, input.name)] =
						input.default != null ? String(input.default) : '';
				}
			}
			formValues = init;
		} catch (e) {
			loadError = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	function appendLog(text: string) {
		runLog += text;
		queueMicrotask(() => {
			if (logEl) logEl.scrollTop = logEl.scrollHeight;
		});
	}

	function canRun(action: ActionMeta): boolean {
		return action.permission !== 'admin' || canRunAdmin;
	}

	function collectInputs(action: ActionMeta): Record<string, string> {
		const values: Record<string, string> = {};
		for (const input of action.inputs) {
			values[input.name] = formValues[fieldKey(action.id, input.name)] ?? '';
		}
		return values;
	}

	function resolveCommand(action: ActionMeta, command: string): string {
		const values = collectInputs(action);
		return command.replace(INPUT_TOKEN, (_, name: string) => values[name] ?? '');
	}

	async function run(action: ActionMeta) {
		if (runningId) return;
		if (!canRun(action)) return;
		// Client-side required check for a friendly message; the server is
		// authoritative and re-validates.
		const missing = action.inputs.find(
			(i) => i.required && !formValues[fieldKey(action.id, i.name)]
		);
		if (missing) {
			alert(`"${missing.label}" is required.`);
			return;
		}
		const preview = action.commands.map((c) => `$ ${resolveCommand(action, c)}`).join('\n');
		if (!confirm(`Run "${action.label}"?\n\n${preview}`)) return;
		runningId = action.id;
		runLabel = action.label;
		runStatus = 'running';
		runLog = '';
		try {
			const init: StreamSseInit = { method: 'POST' };
			if (action.inputs.length > 0) {
				init.body = JSON.stringify({ inputs: collectInputs(action) });
				init.headers = { 'content-type': 'application/json' };
			}
			for await (const ev of streamSse<ActionEvent>(
				`/api/conversations/${conversationId}/actions/${action.id}`,
				init
			)) {
				switch (ev.type) {
					case 'step':
						appendLog(`\n$ ${ev.cmd}\n`);
						break;
					case 'log':
						appendLog(ev.text);
						break;
					case 'step-done':
						if (ev.code !== 0) appendLog(`[${ev.label}] exited with code ${ev.code}\n`);
						break;
					case 'done':
						if (ev.ok) {
							runStatus = 'ok';
							appendLog('\n✓ done\n');
						} else {
							runStatus = 'failed';
							appendLog(
								`\n✗ failed${ev.failedStep ? ` at: ${ev.failedStep}` : ''}${ev.message ? ` (${ev.message})` : ''}\n`
							);
						}
						break;
				}
			}
			if (runStatus === 'running') {
				// Stream ended without a terminal `done` (e.g. disconnect).
				runStatus = 'failed';
				appendLog('\n✗ stream ended unexpectedly\n');
			}
		} catch (e) {
			runStatus = 'failed';
			appendLog(`\nstream error: ${e instanceof Error ? e.message : String(e)}\n`);
		} finally {
			runningId = null;
		}
	}
</script>

<div class="actions-panel">
	<PanelHeader title="Actions" fullBleed>
		{#snippet meta()}Run project scripts defined in this repo's <code>.zap/actions.json</code
			>.{/snippet}
	</PanelHeader>

	{#if loading}
		<p class="muted small">Loading actions…</p>
	{:else if loadError}
		<p class="error small">{loadError}</p>
	{:else}
		{#if configError}
			<p class="error small">{configError}</p>
		{/if}
		{#if actions.length === 0 && !configError}
			<p class="muted small">
				No actions defined. Add buttons by committing a <code>.zap/actions.json</code> file to this project.
			</p>
		{/if}
		{#if actions.length > 0}
			<ul class="action-list">
				{#each actions as action (action.id)}
					<li class="action-item">
						<div class="action-row">
							<div class="action-text">
								<span class="action-label">{action.label}</span>
								{#if action.permission === 'admin'}
									<span class="badge">admin</span>
								{/if}
								{#if action.description}
									<span class="action-desc">{action.description}</span>
								{/if}
							</div>
							<button
								class="btn"
								onclick={() => run(action)}
								disabled={runningId !== null || !canRun(action)}
								title={!canRun(action)
									? 'Requires an authorized admin'
									: action.commands.join('\n')}
							>
								{runningId === action.id ? 'Running…' : 'Run'}
							</button>
						</div>
						{#if action.inputs.length > 0}
							<div class="action-inputs">
								{#each action.inputs as input (input.name)}
									<label class="field">
										<span class="field-label">
											{input.label}{#if input.required}<span class="req" title="required">*</span
												>{/if}
										</span>
										{#if input.type === 'enum'}
											<select
												bind:value={formValues[fieldKey(action.id, input.name)]}
												disabled={runningId !== null || !canRun(action)}
											>
												{#if !input.required}<option value="">—</option>{/if}
												{#each input.options ?? [] as opt (opt)}
													<option value={opt}>{opt}</option>
												{/each}
											</select>
										{:else if input.type === 'number'}
											<input
												type="number"
												bind:value={formValues[fieldKey(action.id, input.name)]}
												placeholder={input.placeholder ?? ''}
												disabled={runningId !== null || !canRun(action)}
											/>
										{:else}
											<input
												type="text"
												bind:value={formValues[fieldKey(action.id, input.name)]}
												placeholder={input.placeholder ?? ''}
												disabled={runningId !== null || !canRun(action)}
											/>
										{/if}
									</label>
								{/each}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{/if}

	{#if runStatus !== 'idle'}
		<div class="run-status">
			<span class="run-name">{runLabel}</span>
			<span class="status eyebrow {runStatus}">{runStatus}</span>
		</div>
	{/if}
	{#if runLog}
		<pre bind:this={logEl} class="log">{runLog}</pre>
	{/if}
</div>

<style>
	.actions-panel {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem;
		margin: 1rem;
		overflow: hidden;
	}
	.action-list {
		list-style: none;
		margin: 0.5rem 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.action-item {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
	}
	.action-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}
	.action-inputs {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.field-label {
		font-size: var(--fs-sm);
		color: var(--text-muted);
	}
	.req {
		color: var(--danger);
		margin-left: 0.15rem;
	}
	.field input,
	.field select {
		padding: 0.35rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text);
		font-size: var(--fs-md);
	}
	.action-text {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}
	.action-label {
		font-weight: 700;
	}
	.action-desc {
		color: var(--text-muted);
		font-size: var(--fs-md);
	}
	.badge {
		display: inline-block;
		margin-left: 0.4rem;
		padding: 0 0.35rem;
		border-radius: var(--radius-sm);
		background: var(--code-bg);
		color: var(--text-muted);
		font-size: var(--fs-sm);
		font-weight: 700;
		text-transform: uppercase;
	}
	.run-status {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		margin-top: 0.75rem;
	}
	.run-name {
		font-weight: 700;
	}
	.status.running {
		color: var(--accent);
	}
	.status.ok {
		color: var(--success);
	}
	.status.failed {
		color: var(--danger);
	}
	.small {
		font-size: var(--fs-md);
	}
	.error {
		color: var(--danger);
	}
	code {
		background: var(--code-bg);
		padding: 0 0.25rem;
		border-radius: var(--radius-sm);
	}
	pre.log {
		margin-top: 0.75rem;
		max-height: 360px;
		overflow: auto;
		padding: 0.75rem;
		background: var(--code-bg);
		border: 1px solid var(--code-border);
		border-radius: var(--radius-sm);
		font-size: var(--code-fs);
		white-space: pre-wrap;
		word-break: break-word;
	}
</style>
