<script lang="ts">
	import type {
		ApprovalMode,
		Conversation,
		ConversationUsage,
		MemoryMode,
		SessionMode,
		WorktreeIntegration
	} from '$lib/types';
	import { onDestroy, untrack } from 'svelte';
	import { invalidateWorktreeStatus, worktreeStatusRevision } from '$lib/client/worktree-status';
	import ContextMeter from './ContextMeter.svelte';
	import ConfirmDialog from './ui/ConfirmDialog.svelte';
	import ModelPicker from './ui/ModelPicker.svelte';
	import { PORTAL_TOOL_GROUPS, type PortalToolGroupId } from '$lib/tools/groups';

	let {
		title,
		conversation,
		model,
		modelOptions = [],
		parent = null,
		usage = null,
		mode,
		memoryMode,
		memoryExtractorModel,
		globalMemoryEnabled,
		approvalMode,
		disabledToolGroups,
		modelChangeDisabled = false,
		onSettingsChange
	}: {
		title: string;
		conversation: Conversation;
		model: string;
		/** Enabled portal models as `providerId/modelId`, offered as suggestions. */
		modelOptions?: string[];
		parent?: {
			id: string;
			title: string;
			messageId: string | null;
			messageIndex: number | null;
		} | null;
		usage?: ConversationUsage | null;
		mode: SessionMode;
		memoryMode: MemoryMode;
		memoryExtractorModel: string | null;
		globalMemoryEnabled: boolean;
		approvalMode: ApprovalMode;
		disabledToolGroups: PortalToolGroupId[];
		modelChangeDisabled?: boolean;
		// Fires with the optimistic patch right before the PATCH request,
		// so the parent can mirror state without waiting for the SSE echo.
		onSettingsChange?: (patch: {
			model?: string;
			mode?: SessionMode;
			memoryMode?: MemoryMode;
			memoryExtractorModel?: string | null;
			globalMemoryEnabled?: boolean;
			approvalMode?: ApprovalMode;
			disabledToolGroups?: PortalToolGroupId[];
		}) => void;
	} = $props();

	let expanded = $state(false);
	let savingModel = $state(false);
	let savingMode = $state(false);
	let savingMemory = $state(false);
	let savingHarvester = $state(false);
	let savingGlobalMemory = $state(false);
	let savingApprove = $state(false);
	let savingToolGroups = $state(false);
	let approveConfirmOpen = $state(false);

	const MODES: { value: SessionMode; label: string; hint: string }[] = [
		{
			value: 'interactive',
			label: 'Interactive',
			hint: 'Normal chat; tools prompt for permission.'
		},
		{
			value: 'autopilot',
			label: 'Autopilot',
			hint: 'Agent decides when to switch into less-supervised execution.'
		}
	];
	const APPROVAL_MODE_OPTIONS: { value: ApprovalMode; label: string; note: string }[] = [
		{
			value: 'ask',
			label: 'Ask every time',
			note: 'Tool calls not covered by a grant or your policy raise a permission dialog and wait for you.'
		},
		{
			value: 'auto-approve',
			label: 'Auto-approve prompts',
			note: 'Prompt-worthy tool calls are approved without asking. Deny grants and always-prompt actions still apply, and each auto-approval is audited as auto-allow.'
		},
		{
			value: 'auto-deny',
			label: 'Auto-deny prompts (best effort)',
			note: 'Permission prompts are auto-rejected with feedback. The agent can keep trying alternatives, but it must stop once extra permission is truly required.'
		}
	];
	const MEMORY_MODES: { value: MemoryMode; label: string; hint: string }[] = [
		{ value: 'off', label: 'Off', hint: 'Use the provider context normally.' },
		{
			value: 'lightweight',
			label: 'Lightweight',
			hint: 'Fresh context with durable decisions, facts, preferences, and open loops.'
		},
		{
			value: 'project',
			label: 'Project',
			hint: 'Coding-aware memory; repository claims remain historical until rechecked.'
		},
		{
			value: 'story',
			label: 'Story',
			hint: 'Track characters, objects, locations, and plot state.'
		},
		{
			value: 'strict',
			label: 'Strict',
			hint: 'Aggressive recall and validation for timelines, secrets, clues, and tiny details.'
		}
	];

	const currentApprovalNote = $derived(
		APPROVAL_MODE_OPTIONS.find((opt) => opt.value === approvalMode)?.note ?? ''
	);
	const showContextMeter = $derived(usage !== null);
	const currentHarvesterModel = $derived(memoryExtractorModel ?? '');

	async function patchSession(body: {
		model?: string;
		mode?: SessionMode;
		memoryMode?: MemoryMode;
		memoryExtractorModel?: string | null;
		globalMemoryEnabled?: boolean;
		approvalMode?: ApprovalMode;
		disabledToolGroups?: PortalToolGroupId[];
	}) {
		const res = await fetch(`/api/conversations/${conversation.id}/session`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) throw new Error(`session patch failed: ${res.status}`);
	}

	async function chooseModel(next: string) {
		const trimmed = next.trim();
		if (!trimmed || trimmed === model || savingModel || modelChangeDisabled) return;
		savingModel = true;
		const prev = model;
		onSettingsChange?.({ model: trimmed });
		try {
			await patchSession({ model: trimmed });
		} catch {
			onSettingsChange?.({ model: prev });
		} finally {
			savingModel = false;
		}
	}

	async function chooseMode(next: SessionMode) {
		if (next === mode || savingMode) return;
		savingMode = true;
		const prev = mode;
		onSettingsChange?.({ mode: next });
		try {
			await patchSession({ mode: next });
		} catch {
			onSettingsChange?.({ mode: prev });
		} finally {
			savingMode = false;
		}
	}

	async function chooseMemoryMode(next: MemoryMode) {
		if (next === memoryMode || savingMemory || modelChangeDisabled) return;
		savingMemory = true;
		const prev = memoryMode;
		onSettingsChange?.({ memoryMode: next });
		try {
			await patchSession({ memoryMode: next });
		} catch {
			onSettingsChange?.({ memoryMode: prev });
		} finally {
			savingMemory = false;
		}
	}

	async function chooseHarvesterModel(next: string | null) {
		const normalized = next?.trim() || null;
		if (normalized === memoryExtractorModel || savingHarvester || modelChangeDisabled) return;
		savingHarvester = true;
		const prev = memoryExtractorModel;
		onSettingsChange?.({ memoryExtractorModel: normalized });
		try {
			await patchSession({ memoryExtractorModel: normalized });
		} catch {
			onSettingsChange?.({ memoryExtractorModel: prev });
		} finally {
			savingHarvester = false;
		}
	}

	async function toggleGlobalMemory(e: Event) {
		const next = (e.currentTarget as HTMLInputElement).checked;
		if (savingGlobalMemory || modelChangeDisabled) return;
		savingGlobalMemory = true;
		const prev = globalMemoryEnabled;
		onSettingsChange?.({ globalMemoryEnabled: next });
		try {
			await patchSession({ globalMemoryEnabled: next });
		} catch {
			onSettingsChange?.({ globalMemoryEnabled: prev });
		} finally {
			savingGlobalMemory = false;
		}
	}

	// Switching *into* auto-approve stops permission prompts for this
	// conversation until it is changed back, so it is the one option gated
	// behind a deliberate confirmation. The select snaps back until confirmed.
	function chooseApprovalMode(e: Event) {
		const target = e.currentTarget as HTMLSelectElement;
		const next = target.value as ApprovalMode;
		if (savingApprove || next === approvalMode) {
			target.value = approvalMode;
			return;
		}
		if (next === 'auto-approve') {
			target.value = approvalMode;
			approveConfirmOpen = true;
			return;
		}
		void applyApprovalMode(next);
	}

	function cancelApproveAll() {
		approveConfirmOpen = false;
	}

	async function confirmApproveAll() {
		await applyApprovalMode('auto-approve');
		approveConfirmOpen = false;
	}

	async function applyApprovalMode(next: ApprovalMode) {
		if (savingApprove) return;
		savingApprove = true;
		const prev = approvalMode;
		onSettingsChange?.({ approvalMode: next });
		try {
			await patchSession({ approvalMode: next });
		} catch {
			onSettingsChange?.({ approvalMode: prev });
		} finally {
			savingApprove = false;
		}
	}

	const disabledToolGroupSet = $derived(new Set<PortalToolGroupId>(disabledToolGroups));

	async function toggleToolGroup(id: PortalToolGroupId, e: Event) {
		const target = e.currentTarget as HTMLInputElement;
		// checked = group enabled; unchecked = group disabled.
		const enabled = target.checked;
		if (savingToolGroups) {
			target.checked = !disabledToolGroupSet.has(id);
			return;
		}
		const prev = disabledToolGroups;
		const next = enabled ? prev.filter((g) => g !== id) : prev.includes(id) ? prev : [...prev, id];
		savingToolGroups = true;
		onSettingsChange?.({ disabledToolGroups: next });
		try {
			await patchSession({ disabledToolGroups: next });
		} catch {
			onSettingsChange?.({ disabledToolGroups: prev });
			target.checked = !prev.includes(id);
		} finally {
			savingToolGroups = false;
		}
	}

	// ---- Worktree integration ----
	//
	// Only meaningful for a session that owns an isolated checkout. The status is
	// fetched lazily rather than shipped in the page load because it costs git
	// subprocesses (see the route comment) and only matters once the user is
	// actually looking at the session's workspace details.
	let worktree = $state<WorktreeIntegration | null>(null);
	// Last refresh signal acted on; see the effect below.
	let seenWorktreeRevision = 0;
	let merging = $state(false);
	let mergeError = $state<string | null>(null);
	let mergeFlash = $state<string | null>(null);
	let mergeTimer: ReturnType<typeof setTimeout> | null = null;

	async function loadWorktree(id: string) {
		try {
			const res = await fetch(`/api/conversations/${id}/worktree`);
			if (!res.ok) return;
			const next = (await res.json()).worktree ?? null;
			// A slow response for a conversation the user has already navigated away
			// from must not overwrite the current one.
			if (conversation.id === id) worktree = next;
		} catch {
			worktree = null;
		}
	}

	$effect(() => {
		// Tracks the conversation id so switching sessions refetches.
		const id = conversation.id;
		if (conversation.workspaceKind !== 'managed-worktree') {
			worktree = null;
			return;
		}
		worktree = null;
		mergeError = null;
		mergeFlash = null;
		void loadWorktree(id);
	});

	$effect(() => {
		// Something (usually a turn that just ended) says the answer may have
		// moved. Refetch WITHOUT clearing first: the pill should update in place,
		// not flicker off and back on for a state that didn't actually change.
		const revision = $worktreeStatusRevision;
		if (revision === seenWorktreeRevision) return;
		seenWorktreeRevision = revision;
		const id = untrack(() => conversation.id);
		if (untrack(() => conversation.workspaceKind) !== 'managed-worktree') return;
		void loadWorktree(id);
	});

	onDestroy(() => {
		if (mergeTimer) clearTimeout(mergeTimer);
	});

	async function integrate(allowMergeCommit: boolean) {
		if (merging) return;
		merging = true;
		mergeError = null;
		mergeFlash = null;
		try {
			const res = await fetch(`/api/conversations/${conversation.id}/worktree/merge`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ direction: 'to-source', allowMergeCommit })
			});
			const payload = await res.json().catch(() => null);
			if (!res.ok) {
				mergeError = payload?.message ?? `merge failed (${res.status})`;
				return;
			}
			const merge = payload?.merge;
			mergeFlash = merge?.merged ? `Merged ${merge.from} into ${merge.into}` : 'Already up to date';
			worktree = merge?.status ?? worktree;
			// The sidebar badge for this session (and every other worktree's
			// ahead/behind against the source branch) just changed.
			invalidateWorktreeStatus();
			if (mergeTimer) clearTimeout(mergeTimer);
			mergeTimer = setTimeout(() => (mergeFlash = null), 4000);
		} catch (e) {
			mergeError = e instanceof Error ? e.message : 'merge failed';
		} finally {
			merging = false;
		}
	}

	/** Human summary of what this worktree holds that the source branch doesn't. */
	const unmergedLabel = $derived.by(() => {
		if (!worktree?.unmerged) return '';
		const parts: string[] = [];
		if (worktree.ahead > 0) {
			parts.push(
				`${worktree.ahead} commit${worktree.ahead === 1 ? '' : 's'} not in ${worktree.upstreamBranch ?? 'the source branch'}`
			);
		}
		if (worktree.dirtyCount > 0) {
			parts.push(
				`${worktree.dirtyCount} uncommitted change${worktree.dirtyCount === 1 ? '' : 's'}`
			);
		}
		return parts.join(', ');
	});

	const miniPct = $derived.by(() => {
		if (!usage || usage.tokenLimit <= 0) return 0;
		return Math.min(100, (usage.currentTokens / usage.tokenLimit) * 100);
	});
	const miniLevel = $derived.by<'low' | 'mid' | 'high'>(() => {
		if (miniPct >= 90) return 'high';
		if (miniPct >= 70) return 'mid';
		return 'low';
	});
</script>

<header class="chat-header" class:expanded>
	<button
		type="button"
		class="chat-header-row"
		onclick={() => (expanded = !expanded)}
		aria-expanded={expanded}
		aria-controls="chat-header-details"
	>
		<span class="title-wrap"><h2>{title}</h2></span>
		{#if worktree?.unmerged}
			<span
				class="unmerged-pill"
				data-testid="header-unmerged"
				title={unmergedLabel}
				aria-label={`Unmerged worktree work: ${unmergedLabel}`}
			>
				unmerged
			</span>
		{/if}
		{#if usage}
			<span
				class="mini-meter"
				data-level={miniLevel}
				aria-hidden="true"
				title={`${usage.currentTokens.toLocaleString()} / ${usage.tokenLimit.toLocaleString()} tokens`}
			>
				<span class="mini-fill" style="width: {miniPct}%"></span>
			</span>
		{/if}
		<svg
			class="chevron"
			width="12"
			height="12"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M4 6l4 4 4-4" />
		</svg>
	</button>
	<div class="chat-header-details" id="chat-header-details">
		<div class="details-inner">
			<div class="details-body">
				<dl class="header-meta">
					<dt>Model</dt>
					<dd>{model}</dd>
					<dt>Workdir</dt>
					<dd class="mono">{conversation.workdir}</dd>
					<dt>Workspace</dt>
					<dd>
						{conversation.workspaceKind === 'managed-worktree' ? 'Managed worktree' : 'Shared'}
					</dd>
					{#if conversation.worktreeBranch}
						<dt>Branch</dt>
						<dd class="mono">{conversation.worktreeBranch}</dd>
					{/if}
					{#if conversation.worktreeBaseSha}
						<dt>Base</dt>
						<dd class="mono">{conversation.worktreeBaseSha.slice(0, 8)}</dd>
					{/if}
					{#if worktree?.isLinkedWorktree}
						<dt>Source branch</dt>
						<dd class="mono">{worktree.upstreamBranch ?? '(detached)'}</dd>
						<dt>Integration</dt>
						<dd>
							{#if worktree.unmerged}
								{unmergedLabel}
							{:else}
								Fully merged{worktree.behind > 0 ? `, ${worktree.behind} behind` : ''}
							{/if}
						</dd>
					{/if}
					<dt>ID</dt>
					<dd class="mono">{conversation.id}</dd>
				</dl>
				{#if worktree?.isLinkedWorktree}
					<div class="worktree-actions">
						<button
							type="button"
							class="worktree-merge"
							disabled={merging || worktree.ahead === 0}
							onclick={() => integrate(false)}
						>
							{merging ? 'Merging…' : `Merge into ${worktree.upstreamBranch ?? 'source'}`}
						</button>
						{#if worktree.behind > 0}
							<button
								type="button"
								class="worktree-merge secondary"
								disabled={merging || worktree.ahead === 0}
								onclick={() => integrate(true)}
							>
								Allow merge commit
							</button>
						{/if}
						{#if mergeFlash}<span class="worktree-flash ok">{mergeFlash}</span>{/if}
						{#if mergeError}<span class="worktree-flash err">{mergeError}</span>{/if}
					</div>
				{/if}
				{#if parent}
					<div class="parent-crumb">
						<svg
							width="11"
							height="11"
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<path d="M6 3l-3 3 3 3" />
							<path d="M3 6h7a3 3 0 013 3v4" />
						</svg>
						<span>Forked from</span>
						<a href={`/conversations/${parent.id}`}>{parent.title}</a>
						{#if parent.messageIndex != null}
							<span>· at message {parent.messageIndex + 1}</span>
						{/if}
					</div>
				{/if}
				{#if showContextMeter}
					<ContextMeter {usage} />
				{/if}
				<div class="session-settings" role="group" aria-label="Session settings">
					<div class="setting-row model-row">
						<ModelPicker
							label="Model"
							value={model}
							options={modelOptions}
							disabled={savingModel || modelChangeDisabled}
							onchange={(v) => void chooseModel(v)}
						/>
						{#if modelChangeDisabled}
							<span class="unsupported-chip">model locked during turn</span>
						{/if}
					</div>
					<div class="setting-row">
						<span class="setting-label">Mode</span>
						<div class="seg" role="radiogroup" aria-label="Session mode" aria-busy={savingMode}>
							{#each MODES as opt (opt.value)}
								<button
									type="button"
									role="radio"
									aria-checked={mode === opt.value}
									class="seg-btn"
									class:active={mode === opt.value}
									title={opt.hint}
									disabled={savingMode}
									onclick={() => chooseMode(opt.value)}
								>
									{opt.label}
								</button>
							{/each}
						</div>
					</div>
					<div class="setting-row">
						<span class="setting-label">Memory</span>
						<div
							class="seg memory-seg"
							role="radiogroup"
							aria-label="Memory mode"
							aria-busy={savingMemory}
						>
							{#each MEMORY_MODES as opt (opt.value)}
								<button
									type="button"
									role="radio"
									aria-checked={memoryMode === opt.value}
									class="seg-btn"
									class:active={memoryMode === opt.value}
									title={opt.hint}
									disabled={savingMemory || modelChangeDisabled}
									onclick={() => chooseMemoryMode(opt.value)}
								>
									{opt.label}
								</button>
							{/each}
						</div>
						{#if modelChangeDisabled}
							<span class="unsupported-chip">memory locked during turn</span>
						{:else if memoryMode !== 'off'}
							<span
								class="unsupported-chip"
								title="Fresh-context turns include mandatory memory tools."
							>
								fresh context + tools
							</span>
						{/if}
					</div>
					{#if memoryMode !== 'off'}
						<div class="setting-row model-row">
							<ModelPicker
								label="Harvester"
								value={currentHarvesterModel}
								options={modelOptions}
								emptyLabel="Server default harvester"
								disabled={savingHarvester || modelChangeDisabled}
								onchange={(v) => chooseHarvesterModel(v || null)}
							/>
							<span
								class="unsupported-chip"
								title="Overrides the model-backed memory extractor when one is configured. Leave default to use server settings."
							>
								{memoryExtractorModel ?? 'server default'}
							</span>
						</div>
						<div class="setting-row">
							<label class="approve-toggle">
								<input
									type="checkbox"
									checked={globalMemoryEnabled}
									disabled={savingGlobalMemory || modelChangeDisabled}
									onchange={toggleGlobalMemory}
								/>
								<span>Enable cross-session global memory tools</span>
							</label>
							<span
								class="unsupported-chip"
								title="When enabled, this conversation may read and write explicit user-scoped global memories through memory_global_* tools."
							>
								{globalMemoryEnabled ? 'global memory on' : 'session-only'}
							</span>
						</div>
					{/if}
					<div class="setting-row">
						<span class="setting-label">Approvals</span>
						<select
							class="model-select"
							aria-label="Approval mode"
							value={approvalMode}
							disabled={savingApprove}
							onchange={chooseApprovalMode}
						>
							{#each APPROVAL_MODE_OPTIONS as opt (opt.value)}
								<option value={opt.value}>{opt.label}</option>
							{/each}
						</select>
					</div>
					<p class="approve-warning" class:neutral={approvalMode === 'ask'} role="note">
						{currentApprovalNote}
					</p>
					<div class="tool-groups">
						<div class="tool-groups-head">
							<span class="tool-groups-title">Portal tool groups</span>
							<span class="tool-groups-sub">Checked = available to the agent this session.</span>
						</div>
						<div class="tool-groups-grid">
							{#each PORTAL_TOOL_GROUPS as group (group.id)}
								<label class="approve-toggle tool-group" title={group.hint}>
									<input
										type="checkbox"
										checked={!disabledToolGroupSet.has(group.id)}
										disabled={savingToolGroups}
										onchange={(e) => toggleToolGroup(group.id, e)}
									/>
									<span>{group.label}</span>
								</label>
							{/each}
						</div>
						<p class="tool-groups-note" role="note">
							Runtime-native tools (bash, view, edit, task, web_fetch…) are always available — these
							toggles only cover portal-injected tools. Disabling
							<strong>Permissions</strong> removes the agent's self-service grant tools; disabling
							<strong>Memory</strong> gates the memory tools on top of the memory-mode setting. Changes
							take effect on the next turn.
						</p>
					</div>
				</div>
			</div>
		</div>
	</div>
</header>

<ConfirmDialog
	open={approveConfirmOpen}
	title="Auto-approve permission prompts?"
	confirmLabel="Enable for this conversation"
	cancelLabel="Cancel"
	danger
	busy={savingApprove}
	onConfirm={confirmApproveAll}
	onCancel={cancelApproveAll}
>
	<p>
		This auto-approves tool calls in <strong>this conversation only</strong> — the agent stops asking
		you to confirm them here, and your default permission policy is bypassed for it. Your other conversations
		still prompt as usual, and it stays on until you turn it off, including across reloads and new sessions.
	</p>
	<p>
		Deny and prompt grants in your permission settings still apply, and some high-impact portal
		actions — commits, worktree merges and removals, template changes — always ask. Each
		auto-approved portal tool is still recorded in the audit log as <code>auto-allow</code>.
	</p>
</ConfirmDialog>

<style>
	.chat-header {
		border-bottom: 1px solid var(--border);
	}
	.chat-header-row {
		width: 100%;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-5);
		background: transparent;
		border: 0;
		cursor: pointer;
		text-align: left;
		color: inherit;
		font: inherit;
		transition: background 0.12s ease;
	}
	.chat-header-row:hover {
		background: var(--surface-2);
	}
	.chat-header-row:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.title-wrap {
		flex: 1;
		min-width: 0;
	}
	.title-wrap h2 {
		margin: 0;
		font-size: var(--fs-lg);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mini-meter {
		flex: 0 0 auto;
		position: relative;
		width: 72px;
		height: 6px;
		border-radius: 3px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		overflow: hidden;
	}
	.mini-fill {
		position: absolute;
		inset: 0 auto 0 0;
		background: var(--success);
		opacity: 0.6;
		transition: width 240ms ease-out;
	}
	.mini-meter[data-level='mid'] .mini-fill {
		background: var(--warning);
	}
	.mini-meter[data-level='high'] .mini-fill {
		background: var(--danger);
	}
	.chevron {
		flex: 0 0 auto;
		opacity: 0.6;
		transition: transform 160ms ease;
	}
	.chat-header.expanded .chevron {
		transform: rotate(180deg);
	}
	.chat-header-details {
		display: grid;
		grid-template-rows: 0fr;
		transition: grid-template-rows 160ms ease;
	}
	.chat-header.expanded .chat-header-details {
		grid-template-rows: 1fr;
	}
	.details-inner {
		min-height: 0;
		overflow: hidden;
	}
	.details-body {
		padding: var(--space-1) var(--space-5) var(--space-3);
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		font-size: var(--fs-xs);
	}
	.header-meta {
		display: grid;
		grid-template-columns: auto 1fr;
		column-gap: var(--space-3);
		row-gap: var(--space-1);
		margin: 0;
	}
	.header-meta dt {
		opacity: 0.6;
	}
	.header-meta dd {
		margin: 0;
		word-break: break-all;
	}
	.mono {
		font-family: var(--mono);
	}
	.parent-crumb {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		flex-wrap: wrap;
	}
	.parent-crumb a {
		color: inherit;
		text-decoration: underline;
		text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);
	}
	.parent-crumb a:hover {
		text-decoration-color: currentColor;
	}
	.unmerged-pill {
		flex: none;
		font-size: var(--fs-xs);
		font-weight: 600;
		letter-spacing: 0.02em;
		padding: 0.1rem 0.4rem;
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
		color: var(--warning);
		background: var(--warning-bg);
	}
	.worktree-actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.worktree-merge {
		font: inherit;
		font-size: var(--fs-sm);
		padding: 0.25rem 0.6rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		background: var(--surface-2);
		color: inherit;
		cursor: pointer;
	}
	.worktree-merge:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.worktree-merge.secondary {
		background: transparent;
	}
	.worktree-flash {
		font-size: var(--fs-sm);
	}
	.worktree-flash.ok {
		color: var(--success);
	}
	.worktree-flash.err {
		color: var(--danger);
	}
	@media (prefers-reduced-motion: reduce) {
		.chat-header-details,
		.chevron,
		.mini-fill {
			transition: none;
		}
	}
	.session-settings {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding-top: var(--space-2);
		border-top: 1px dashed var(--border);
	}
	.setting-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.setting-label {
		opacity: 0.6;
		min-width: 3.5rem;
	}
	.model-row {
		align-items: flex-start;
	}
	.model-select {
		min-width: min(26rem, 100%);
		max-width: 100%;
		background: var(--surface-2);
		border: 1px solid var(--border-strong, var(--border));
		border-radius: 6px;
		color: inherit;
		font: inherit;
		font-size: var(--fs-xs);
		padding: 4px 10px;
	}
	.model-select {
		appearance: none;
		-webkit-appearance: none;
		-moz-appearance: none;
		cursor: pointer;
		padding-right: 28px;
		background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none' stroke='%23808a99' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E");
		background-repeat: no-repeat;
		background-position: right 8px center;
		background-size: 14px;
	}
	.model-select:hover:not(:disabled) {
		border-color: var(--accent);
	}
	.seg {
		display: inline-flex;
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
		background: var(--surface-2);
	}
	.seg-btn {
		background: transparent;
		border: 0;
		color: inherit;
		font: inherit;
		padding: 2px 10px;
		cursor: pointer;
		transition: background 0.12s ease;
	}
	.seg-btn + .seg-btn {
		border-left: 1px solid var(--border);
	}
	.seg-btn:hover:not(:disabled) {
		background: var(--surface-3, var(--surface-2));
	}
	.seg-btn.active {
		background: var(--accent);
		color: var(--accent-fg, white);
	}
	.seg-btn:disabled {
		opacity: 0.5;
		cursor: progress;
	}
	.approve-toggle {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		cursor: pointer;
	}
	.approve-toggle input[type='checkbox'] {
		margin: 0;
	}
	.model-select:disabled {
		opacity: 0.5;
		cursor: progress;
	}
	.unsupported-chip {
		display: inline-flex;
		align-items: center;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface-2);
		padding: 2px 8px;
		opacity: 0.78;
	}
	.approve-warning {
		margin: 0;
		padding: var(--space-1) var(--space-2);
		background: color-mix(in srgb, var(--warning) 14%, transparent);
		border-left: 2px solid var(--warning);
		border-radius: 3px;
		font-size: var(--fs-xs);
	}
	/* `ask` is the safe default, so its note is informational rather than a warning. */
	.approve-warning.neutral {
		background: var(--surface-2);
		border-left-color: var(--border);
		opacity: 0.85;
	}
	.tool-groups {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		margin-top: var(--space-1);
		padding-top: var(--space-2);
		border-top: 1px solid var(--border);
	}
	.tool-groups-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-1) var(--space-2);
	}
	.tool-groups-title {
		font-weight: 600;
		font-size: var(--fs-sm);
	}
	.tool-groups-sub {
		font-size: var(--fs-xs);
		opacity: 0.72;
	}
	.tool-groups-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 2px var(--space-2);
	}
	.tool-group {
		min-width: 0;
	}
	.tool-groups-note {
		margin: 0;
		font-size: var(--fs-xs);
		opacity: 0.78;
		line-height: 1.4;
	}
</style>
