<script lang="ts">
	import { untrack } from 'svelte';
	import type {
		InteractivePermissionView,
		InteractiveResponse,
		ShellAnalysisView
	} from '$lib/types';
	import { gitCommitPreview } from '$lib/permissions/git-commit';
	import {
		buildPermissionGrantScope,
		buildPermissionScopeContext,
		buildShellOptions,
		defaultScopeChoice,
		operatorGloss,
		previewPersistentPermission,
		scopeOptionLabel,
		type ScopeChoice
	} from './interactive-permission';

	let {
		request,
		onRespond
	}: {
		request: InteractivePermissionView & { requestId: string };
		onRespond: (r: InteractiveResponse) => void;
	} = $props();

	let busy = $state(false);
	let scopeChoice = $state<ScopeChoice>('this-exact');
	let expiryChoice = $state<'forever' | '1h' | '1d'>('forever');
	let appliesTo = $state<'this-conversation' | 'all-conversations'>('this-conversation');
	let denialFeedback = $state(untrack(() => request.defaultDenyFeedback ?? ''));
	let lastFeedbackRequestId = $state<string | null>(null);
	let shellChecked = $state<Record<string, boolean>>({});

	const HOUR_MS = 60 * 60 * 1000;
	const DAY_MS = 24 * HOUR_MS;

	async function pick(r: InteractiveResponse) {
		if (busy) return;
		busy = true;
		try {
			await onRespond(r);
		} finally {
			busy = false;
		}
	}

	function formatArgs(args: unknown): string | null {
		if (args === null || args === undefined) return null;
		if (typeof args === 'string') return args.length > 0 ? args : null;
		try {
			const s = JSON.stringify(args, null, 2);
			return s && s !== '{}' && s !== '[]' ? s : null;
		} catch {
			return String(args);
		}
	}

	const gitCommit = $derived(request.tool === 'git_commit' ? gitCommitPreview(request.args) : null);
	const permissionScopeContext = $derived(buildPermissionScopeContext(request));
	const scopeChoices = $derived<ScopeChoice[]>(permissionScopeContext.choices);
	const isFsKind = $derived(permissionScopeContext.isFsKind);
	const permissionScopeKey = $derived(permissionScopeContext.scopeKey);
	const fsParentDir = $derived(permissionScopeContext.fsParentDir);
	const denyAllPolicy = $derived(request.userPolicy === 'deny-all');
	const canPersistDecision = $derived(request.canPersistDecision !== false);
	const shellAnalysis = $derived<ShellAnalysisView | null>(
		request.permissionKind === 'shell' ? (request.shellAnalysis ?? null) : null
	);
	const isShellRequest = $derived(request.permissionKind === 'shell');
	const isShellWithAnalysis = $derived(
		isShellRequest && shellAnalysis !== null && shellAnalysis.kind === 'parsed'
	);
	const isShellUnsafe = $derived(
		isShellRequest && shellAnalysis !== null && shellAnalysis.kind === 'unsafe'
	);
	const shellOptions = $derived(
		shellAnalysis && shellAnalysis.kind === 'parsed'
			? buildShellOptions(shellAnalysis.segments)
			: []
	);
	const shellCheckedCount = $derived(
		shellOptions.reduce((n, o) => n + (shellChecked[o.id] ? 1 : 0), 0)
	);

	$effect(() => {
		const requestId = request.requestId;
		if (lastFeedbackRequestId !== requestId) {
			lastFeedbackRequestId = requestId;
			denialFeedback = request.defaultDenyFeedback ?? '';
		}
	});

	$effect(() => {
		if (isFsKind) {
			scopeChoice = permissionScopeKey ? 'this-exact' : 'this-directory';
		} else {
			scopeChoice = defaultScopeChoice(permissionScopeContext);
		}
	});

	$effect(() => {
		void shellOptions;
		shellChecked = {};
	});

	function denyFeedback(): string | undefined {
		const trimmed = denialFeedback.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}

	function pickDeny(decision: 'deny' | 'deny-always') {
		const feedback = denyFeedback();
		pick(feedback ? { kind: 'permission', decision, feedback } : { kind: 'permission', decision });
	}

	function buildExpiry(): number | undefined {
		switch (expiryChoice) {
			case '1h':
				return HOUR_MS;
			case '1d':
				return DAY_MS;
			case 'forever':
			default:
				return undefined;
		}
	}

	function previewShellAlways(decision: 'allow-always' | 'deny-always'): string {
		const verb = decision === 'allow-always' ? 'Allow' : 'Deny';
		const where =
			appliesTo === 'all-conversations' ? 'in every conversation' : 'in this conversation';
		const ttl =
			expiryChoice === '1h' ? ', for 1 hour' : expiryChoice === '1d' ? ', for 1 day' : ', forever';
		const checked = shellOptions.filter((o) => shellChecked[o.id]);
		if (checked.length === 0) {
			return `${verb} … (pick at least one scope below) ${where}${ttl}.`;
		}
		const list = checked.map((o) => o.summary).join('; ');
		return `${verb} ${list} ${where}${ttl}.`;
	}

	function pickAlways(decision: 'allow-always' | 'deny-always') {
		if (!canPersistDecision) return;
		if (decision === 'allow-always' && denyAllPolicy) return;
		if (isShellWithAnalysis && shellOptions.length > 0) {
			const checked = shellOptions.filter((o) => shellChecked[o.id]);
			if (checked.length === 0) return;
			const [first, ...rest] = checked;
			pick({
				kind: 'permission',
				decision,
				scope: { permissionKind: 'shell', scope: first.scope },
				additionalScopes: rest.map((o) => ({
					permissionKind: 'shell',
					scope: o.scope
				})),
				expiresInMs: buildExpiry(),
				applyToAllConversations: appliesTo === 'all-conversations',
				...(decision === 'deny-always' && denyFeedback() ? { feedback: denyFeedback() } : {})
			});
			return;
		}
		pick({
			kind: 'permission',
			decision,
			scope: buildPermissionGrantScope(request, permissionScopeContext, scopeChoice),
			expiresInMs: buildExpiry(),
			applyToAllConversations: appliesTo === 'all-conversations',
			...(decision === 'deny-always' && denyFeedback() ? { feedback: denyFeedback() } : {})
		});
	}

	function previewAlways(decision: 'allow-always' | 'deny-always'): string {
		return previewPersistentPermission(
			request,
			permissionScopeContext,
			scopeChoice,
			decision,
			appliesTo,
			expiryChoice
		);
	}

	function onKeyDown(e: KeyboardEvent) {
		if (busy) return;
		if (e.currentTarget !== e.target) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			pickDeny('deny');
		} else if (e.key === 'Enter' && e.shiftKey) {
			if (!canPersistDecision) return;
			if (denyAllPolicy) return;
			e.preventDefault();
			pickAlways('allow-always');
		} else if (e.key === 'Enter') {
			e.preventDefault();
			pick({ kind: 'permission', decision: 'allow-once' });
		}
	}
</script>

<div class="interactive" role="alertdialog" aria-modal="true" tabindex="-1" onkeydown={onKeyDown}>
	<div class="head">Permission required</div>
	<div class="body">
		<div>
			<strong>{request.tool}</strong>
			<span class="muted">({request.permissionKind})</span>
		</div>
		<pre>{request.summary}</pre>

		{#if isShellWithAnalysis && shellAnalysis && shellAnalysis.kind === 'parsed'}
			<div class="shell-breakdown" aria-label="Pipeline breakdown">
				<div class="muted small">
					Pipeline ({shellAnalysis.segments.length}
					{shellAnalysis.segments.length === 1 ? 'command' : 'commands'}) — every segment runs if
					you allow this:
				</div>
				<ol class="shell-segments">
					{#each shellAnalysis.segments as seg, i (i)}
						<li>
							<code>{seg.argv.join(' ')}</code>
							{#if seg.followingOp}
								<span class="op" title={operatorGloss(seg.followingOp)}
									><code>{seg.followingOp}</code></span
								>
							{/if}
						</li>
					{/each}
				</ol>
			</div>
		{:else if isShellUnsafe && shellAnalysis && shellAnalysis.kind === 'unsafe'}
			<div class="shell-unsafe" role="note">
				<strong>⚠ Can't analyze this command.</strong>
				<div>
					Reason: <code>{shellAnalysis.reason}</code>. Constructs like subshells, redirection,
					command substitution, or variable expansion can hide arbitrary commands, so structured
					"always" grants won't apply here. Review the full command above before allowing.
				</div>
			</div>
		{/if}

		{#if request.escalationReason}
			<div class="shell-unsafe" role="note">
				<strong>Escalation requested.</strong>
				<div>{request.escalationReason}</div>
				<div class="muted small">
					This request can only be allowed once. Persistent decisions are disabled.
				</div>
			</div>
		{/if}

		{#if gitCommit}
			<div class="git-commit-preview" role="note">
				<div class="muted small">Commit preview</div>
				<dl>
					<div>
						<dt>Subject</dt>
						<dd>{gitCommit.subject}</dd>
					</div>
					<div>
						<dt>Target</dt>
						<dd>{gitCommit.targetSummary}</dd>
					</div>
					{#if gitCommit.bodyLineCount > 0}
						<div>
							<dt>Body</dt>
							<dd>
								{gitCommit.bodyLineCount}
								{gitCommit.bodyLineCount === 1 ? 'line' : 'lines'}
							</dd>
						</div>
					{/if}
					{#if gitCommit.trailers.length > 0}
						<div>
							<dt>Trailers</dt>
							<dd>{gitCommit.trailers.length}</dd>
						</div>
					{/if}
					<div>
						<dt>Approval</dt>
						<dd>One-time only; stored grants are disabled for this tool.</dd>
					</div>
				</dl>
				{#if gitCommit.paths}
					<ul class="commit-paths">
						{#each gitCommit.paths as path}
							<li><code>{path}</code></li>
						{/each}
					</ul>
				{/if}
				{#if gitCommit.body}
					<div class="commit-message-block">
						<div class="muted small">Body</div>
						<pre>{gitCommit.body}</pre>
					</div>
				{/if}
				{#if gitCommit.trailers.length > 0}
					<table class="trailers">
						<thead>
							<tr><th class="eyebrow">Trailer</th><th class="eyebrow">Value</th></tr>
						</thead>
						<tbody>
							{#each gitCommit.trailers as trailer}
								<tr>
									<td><code>{trailer.token}</code></td>
									<td>{trailer.value}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</div>
		{/if}

		{#if formatArgs(request.args)}
			<details class="args">
				<summary>{gitCommit ? 'Raw arguments' : 'Arguments'}</summary>
				<pre>{formatArgs(request.args)}</pre>
			</details>
		{/if}

		{#if canPersistDecision}
			<details class="grant-scope">
				<summary>Remember this decision (optional)</summary>
				<div class="scope-body">
					{#if isShellWithAnalysis}
						<fieldset class="scope-group">
							<legend>Persist grants for</legend>
							{#if shellOptions.length === 0}
								<div class="muted small">
									No persistable scopes derivable from this command (all argv[0]s were
									path-qualified or otherwise unsafe to anchor a grant on).
								</div>
							{:else}
								<div class="muted small">
									Check every scope you want to remember. Each becomes its own grant and is combined
									at decision time — covering more invocations than this exact pipeline.
								</div>
								{#each shellOptions as opt (opt.id)}
									<label class="scope-option">
										<input
											type="checkbox"
											checked={!!shellChecked[opt.id]}
											onchange={(e) =>
												(shellChecked[opt.id] = (e.currentTarget as HTMLInputElement).checked)}
										/>
										{opt.label}
									</label>
								{/each}
							{/if}
						</fieldset>
					{:else if isShellUnsafe}
						<div class="muted small">
							Structured grants are unavailable for commands the parser can't model. Use Settings →
							Permissions to add a coarse "any shell from this tool" grant if you really want one.
						</div>
					{:else}
						<fieldset class="scope-group">
							<legend>Scope</legend>
							{#each scopeChoices as choice (choice)}
								{@const c = choice as typeof scopeChoice}
								<label class="scope-option">
									<input
										type="radio"
										name="perm-scope"
										value={c}
										checked={scopeChoice === c}
										disabled={(c === 'this-exact' && !permissionScopeKey) ||
											(c === 'this-directory' && !fsParentDir)}
										onchange={() => (scopeChoice = c)}
									/>
									{scopeOptionLabel(request, permissionScopeContext, c)}
								</label>
							{/each}
							{#if scopeChoice === 'this-exact' && permissionScopeKey}
								<div class="muted small">
									Matches pattern: <code>{permissionScopeKey}</code>
								</div>
							{:else if scopeChoice === 'this-directory' && fsParentDir}
								<div class="muted small">
									Matches any path resolving inside <code>{fsParentDir}/</code> (symlinks followed).
								</div>
							{/if}
						</fieldset>
					{/if}
					<fieldset class="scope-group">
						<legend>Applies to</legend>
						<label class="scope-option">
							<input
								type="radio"
								name="perm-applies"
								value="this-conversation"
								checked={appliesTo === 'this-conversation'}
								onchange={() => (appliesTo = 'this-conversation')}
							/>
							Just this conversation
						</label>
						<label class="scope-option">
							<input
								type="radio"
								name="perm-applies"
								value="all-conversations"
								checked={appliesTo === 'all-conversations'}
								onchange={() => (appliesTo = 'all-conversations')}
							/>
							Every conversation (global)
						</label>
					</fieldset>
					<label class="expiry">
						Expires:
						<select
							value={expiryChoice}
							onchange={(e) =>
								(expiryChoice = (e.currentTarget as HTMLSelectElement).value as
									| 'forever'
									| '1h'
									| '1d')}
						>
							<option value="forever">Never</option>
							<option value="1h">In 1 hour</option>
							<option value="1d">In 1 day</option>
						</select>
					</label>
				</div>
			</details>
		{/if}
		<label class="deny-feedback">
			<span>Optional feedback if you deny</span>
			<textarea
				bind:value={denialFeedback}
				maxlength="500"
				rows="3"
				disabled={busy}
				placeholder="Tell the agent why this is denied or what to try instead..."
			></textarea>
			<span class="muted small">{denialFeedback.length}/500 characters</span>
		</label>
	</div>
	<div class="actions">
		{#if canPersistDecision}
			<button
				class="btn"
				disabled={busy}
				onclick={() => pickAlways('deny-always')}
				title={isShellWithAnalysis
					? previewShellAlways('deny-always')
					: previewAlways('deny-always')}>Deny always</button
			>
		{/if}
		<button class="btn" disabled={busy} onclick={() => pickDeny('deny')} title="Esc">Deny</button>
		<button
			class="btn"
			disabled={busy}
			onclick={() => pick({ kind: 'permission', decision: 'allow-once' })}
			title="Enter">Allow once</button
		>
		{#if canPersistDecision}
			<button
				class="btn primary"
				disabled={busy ||
					denyAllPolicy ||
					isShellUnsafe ||
					(isShellWithAnalysis && shellCheckedCount === 0)}
				onclick={() => pickAlways('allow-always')}
				title={denyAllPolicy
					? 'Your default policy is "Deny all" — change it in Settings before saving Allow grants.'
					: isShellUnsafe
						? 'Structured grants unavailable for unparseable commands. Use "Allow once" or add a grant from Settings.'
						: isShellWithAnalysis && shellCheckedCount === 0
							? 'Check at least one scope above to remember this allow.'
							: `${isShellWithAnalysis ? previewShellAlways('allow-always') : previewAlways('allow-always')}  (Shift+Enter)`}
				>Allow always</button
			>
		{/if}
	</div>
	{#if canPersistDecision}
		<div class="preview muted small" aria-live="polite">
			<span
				><strong>Allow always</strong> → {isShellWithAnalysis
					? previewShellAlways('allow-always')
					: previewAlways('allow-always')}</span
			>
			<span
				><strong>Deny always</strong> → {isShellWithAnalysis
					? previewShellAlways('deny-always')
					: previewAlways('deny-always')}</span
			>
			{#if denyAllPolicy}
				<span class="warning"
					>Default policy is <strong>Deny all</strong>; "Allow always" is disabled so it doesn't get
					silently dropped.</span
				>
			{/if}
		</div>
	{/if}
</div>

<style>
	.interactive {
		border: 1px solid var(--warning);
		background: var(--warning-bg);
		border-radius: var(--radius-lg);
		padding: var(--space-3) var(--space-4);
	}
	.head {
		font-weight: 600;
		margin-bottom: 0.4rem;
	}
	.body pre {
		background: var(--surface);
		max-height: 200px;
		overflow: auto;
		margin-top: 0.4rem;
		font-size: 0.85em;
	}
	.body details.args {
		margin-top: 0.4rem;
		font-size: 0.85em;
	}
	.body details.args > summary {
		cursor: pointer;
		opacity: 0.8;
	}
	.body details.args pre {
		margin-top: 0.3rem;
		max-height: 240px;
	}
	.body details.grant-scope {
		margin-top: 0.6rem;
		padding: 0.4rem 0.5rem;
		border: 1px dashed var(--border);
		border-radius: var(--radius-sm);
		font-size: 0.85em;
	}
	.body details.grant-scope > summary {
		cursor: pointer;
		opacity: 0.85;
	}
	.scope-body,
	.scope-group,
	.shell-segments,
	.preview {
		display: flex;
		flex-direction: column;
	}
	.scope-body {
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
	.scope-group {
		border: none;
		padding: 0;
		margin: 0;
		gap: 0.2rem;
	}
	.scope-group legend {
		font-weight: 600;
		padding: 0 0 0.2rem;
	}
	.scope-option {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-weight: normal;
	}
	.scope-option:has(input[type='radio']:disabled) {
		opacity: 0.5;
	}
	.shell-breakdown,
	.shell-unsafe,
	.git-commit-preview {
		margin-top: 0.5rem;
		border-radius: var(--radius-sm);
		font-size: 0.85em;
	}
	.shell-breakdown,
	.git-commit-preview {
		padding: 0.4rem 0.5rem;
		border: 1px solid var(--border);
		background: var(--surface);
	}
	.shell-unsafe {
		padding: 0.4rem 0.5rem;
		border: 1px solid var(--danger, var(--warning));
		background: var(--danger-bg, var(--warning-bg));
	}
	.shell-segments {
		margin: 0.3rem 0 0;
		padding-left: 1.3rem;
		gap: 0.15rem;
	}
	.shell-segments li {
		line-height: 1.4;
	}
	.shell-segments code {
		font-size: 0.95em;
	}
	.shell-segments .op {
		margin-left: 0.4rem;
		opacity: 0.75;
		font-size: 0.85em;
	}
	.shell-unsafe strong {
		display: block;
		margin-bottom: 0.2rem;
	}
	.git-commit-preview {
		padding: 0.5rem 0.6rem;
	}
	.git-commit-preview dl {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 0.25rem 0.7rem;
		margin: 0.35rem 0 0;
	}
	.git-commit-preview dl > div {
		display: contents;
	}
	.git-commit-preview dt {
		color: var(--text-muted);
		font-weight: 600;
	}
	.git-commit-preview dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.commit-paths {
		margin: 0.5rem 0 0;
		padding-left: 1.2rem;
		max-height: 10rem;
		overflow: auto;
	}
	.commit-paths li {
		margin: 0.1rem 0;
	}
	.commit-message-block {
		margin-top: 0.5rem;
	}
	.commit-message-block pre {
		margin-top: 0.25rem;
		max-height: 10rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.trailers {
		width: 100%;
		margin-top: 0.5rem;
		border-collapse: collapse;
	}
	.trailers th,
	.trailers td {
		padding: 0.2rem 0.3rem;
		border-top: 1px solid var(--border);
		text-align: left;
		vertical-align: top;
	}
	.expiry {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.expiry select,
	select {
		padding: 0.3rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: inherit;
	}
	.deny-feedback {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-top: 0.6rem;
		font-size: 0.85em;
	}
	.deny-feedback span:first-child {
		font-weight: 600;
	}
	.deny-feedback textarea {
		width: 100%;
		box-sizing: border-box;
		resize: vertical;
		padding: 0.35rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: inherit;
		font: inherit;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.6rem;
		justify-content: flex-end;
		flex-wrap: wrap;
	}
	.preview {
		margin-top: 0.4rem;
		gap: 0.15rem;
		font-size: 0.8em;
		line-height: 1.35;
	}
	.preview .warning {
		color: var(--danger);
	}
</style>
