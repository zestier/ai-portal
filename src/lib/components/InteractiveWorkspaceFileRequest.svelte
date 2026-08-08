<script lang="ts">
	import type { InteractiveResponse } from '$lib/types';
	import type { InteractiveWorkspaceFileView } from '$lib/types';
	import DiffView from './DiffView.svelte';
	import Alert from './ui/Alert.svelte';

	type WorkspaceFileRequest = InteractiveWorkspaceFileView & { requestId: string };

	let {
		request,
		busy,
		onRespond
	}: {
		request: WorkspaceFileRequest;
		busy: boolean;
		onRespond: (r: InteractiveResponse) => void;
	} = $props();
</script>

<div class="head">Workspace permissions review</div>
<div class="body">
	<p>{request.summary}</p>
	<p class="meta">
		File <code>{request.fileName}</code>
		<span class="root">in {request.workspaceRoot}</span>
		{#if request.acceptedHash !== null}
			&middot; {request.activeGrantCount} grant{request.activeGrantCount === 1 ? '' : 's'} active from
			the last approved version
		{/if}
	</p>

	{#if request.parseError}
		<Alert kind="error">
			This file is not a valid permissions file and cannot be imported. Fix it to review it again:
			<code>{request.parseError}</code>
		</Alert>
	{:else if request.diff}
		<details class="diff">
			<summary>Show changes</summary>
			<DiffView path={request.fileName} diff={request.diff} collapsible={false} />
		</details>
	{/if}
</div>
<div class="actions">
	{#if !request.parseError}
		<button
			class="btn btn-primary"
			disabled={busy}
			onclick={() => onRespond({ kind: 'workspace_file', decision: 'approve' })}
			>Approve &amp; apply</button
		>
	{/if}
	<button
		class="btn"
		disabled={busy}
		onclick={() => onRespond({ kind: 'workspace_file', decision: 'reject' })}
		>Keep current state</button
	>
</div>

<style>
	.meta {
		color: var(--text-muted);
		font-size: var(--fs-md);
	}
	.meta code {
		background: var(--surface);
		padding: 0 0.2rem;
		border-radius: var(--radius-sm);
	}
	.root {
		margin-left: 0.4rem;
	}
	.diff {
		margin-top: 0.5rem;
	}
	.diff summary {
		cursor: pointer;
		margin-bottom: 0.3rem;
	}
</style>
