<script lang="ts">
	import { untrack } from 'svelte';
	import FileTree from './FileTree.svelte';
	import CommitList from './CommitList.svelte';
	import ChangeList from './ChangeList.svelte';
	import DiffView from './DiffView.svelte';
	import GitStatusHeader from './GitStatusHeader.svelte';
	import StatusBadge from './StatusBadge.svelte';
	import EmptyState from './ui/EmptyState.svelte';
	import Alert from './ui/Alert.svelte';
	import type {
		FsEntry,
		FileResponse,
		CommitDetail,
		ChangeEntry,
		ChangeStatus
	} from '$lib/client/file-browser';
	import { worktreeParams } from '$lib/client/file-browser';
	import { reviewStore } from '$lib/client/review.svelte';
	import { lineKey, type ReviewLocation } from '$lib/client/review-format';
	import {
		escapeHtml,
		highlightCodeLines,
		languageForPath,
		type HighlightedLines
	} from '$lib/client/syntax-highlight';

	type Pane = 'changes' | 'files' | 'commits';
	let {
		conversationId,
		pane = 'changes',
		worktree = null,
		refreshToken = 0,
		onSendToChat
	}: {
		conversationId: string;
		pane?: Pane;
		/** Selected worktree lease id, or null for the conversation's own workspace. */
		worktree?: string | null;
		/** Bumped by the parent to force a re-read (e.g. after a merge). */
		refreshToken?: number;
		onSendToChat?: () => void;
	} = $props();

	type ViewMode = 'content' | 'diff';

	let viewMode = $state<ViewMode>('content');
	let selectedPath = $state<string | null>(null);
	let selectedStatus = $state<ChangeStatus | null>(null);
	let fileData = $state<FileResponse | null>(null);
	let fileLoading = $state(false);
	let fileError = $state<string | null>(null);

	let diffText = $state<string>('');
	let diffLoading = $state(false);
	let diffError = $state<string | null>(null);

	let selectedSha = $state<string | null>(null);
	let commitDetail = $state<CommitDetail | null>(null);
	let commitDetailError = $state<string | null>(null);
	let commitFilePath = $state<string | null>(null);
	let commitFileDiff = $state<string>('');

	let showHidden = $state(false);
	let showIgnored = $state(false);
	let gitRefreshToken = $state(0);
	let fileRequestSeq = 0;
	let fileAbortController: AbortController | null = null;
	let diffRequestSeq = 0;
	let diffAbortController: AbortController | null = null;
	let commitRequestSeq = 0;
	let commitAbortController: AbortController | null = null;
	let commitFileDiffRequestSeq = 0;
	let commitFileDiffAbortController: AbortController | null = null;

	function isAbortError(e: unknown) {
		return e instanceof Error && e.name === 'AbortError';
	}

	function bumpGitRefresh() {
		gitRefreshToken++;
	}

	// A merge (or any parent-driven refresh) changes both trees, so re-read the
	// panes and drop a selection that may no longer exist.
	$effect(() => {
		void refreshToken;
		untrack(() => {
			if (refreshToken > 0) clearSelectionAndRefresh();
		});
	});

	function clearSelectionAndRefresh() {
		fileAbortController?.abort();
		diffAbortController?.abort();
		fileRequestSeq++;
		diffRequestSeq++;
		selectedPath = null;
		selectedStatus = null;
		fileData = null;
		fileError = null;
		fileLoading = false;
		diffText = '';
		diffError = null;
		diffLoading = false;
		bumpGitRefresh();
	}

	async function loadFile(path: string) {
		const requestSeq = ++fileRequestSeq;
		fileAbortController?.abort();
		const controller = new AbortController();
		fileAbortController = controller;
		fileLoading = true;
		fileError = null;
		fileData = null;
		try {
			const params = worktreeParams(worktree, { path });
			const res = await fetch(`/api/conversations/${conversationId}/fs/file?${params}`, {
				signal: controller.signal
			});
			if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
			const data = (await res.json()) as { file: FileResponse };
			if (requestSeq !== fileRequestSeq || controller.signal.aborted || selectedPath !== path)
				return;
			fileData = data.file;
		} catch (e) {
			if (requestSeq !== fileRequestSeq || controller.signal.aborted || isAbortError(e)) return;
			fileError = e instanceof Error ? e.message : String(e);
		} finally {
			if (requestSeq === fileRequestSeq && fileAbortController === controller) {
				fileLoading = false;
				fileAbortController = null;
			}
		}
	}

	async function loadDiff(path: string) {
		const requestSeq = ++diffRequestSeq;
		diffAbortController?.abort();
		const controller = new AbortController();
		diffAbortController = controller;
		diffLoading = true;
		diffError = null;
		diffText = '';
		try {
			const params = worktreeParams(worktree, { target: 'worktree-vs-head', path });
			const res = await fetch(`/api/conversations/${conversationId}/fs/diff?${params}`, {
				signal: controller.signal
			});
			if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
			const data = (await res.json()) as { diff: string };
			if (requestSeq !== diffRequestSeq || controller.signal.aborted || selectedPath !== path)
				return;
			diffText = data.diff;
		} catch (e) {
			if (requestSeq !== diffRequestSeq || controller.signal.aborted || isAbortError(e)) return;
			diffError = e instanceof Error ? e.message : String(e);
		} finally {
			if (requestSeq === diffRequestSeq && diffAbortController === controller) {
				diffLoading = false;
				diffAbortController = null;
			}
		}
	}

	function pickFile(entry: FsEntry) {
		if (entry.type !== 'file' && entry.type !== 'symlink') return;
		selectedPath = entry.relPath;
		selectedStatus = entry.status;
		// If file has changes, prefer the diff view; else content.
		viewMode =
			entry.status && entry.status !== 'untracked' && entry.status !== 'ignored'
				? 'diff'
				: 'content';
		loadFile(entry.relPath);
		if (viewMode === 'diff') loadDiff(entry.relPath);
	}

	function pickChange(entry: ChangeEntry) {
		selectedPath = entry.path;
		selectedStatus = entry.status;
		diffText = '';
		diffError = null;
		viewMode = entry.status === 'untracked' ? 'content' : 'diff';
		loadFile(entry.path);
		if (viewMode === 'diff') loadDiff(entry.path);
	}

	$effect(() => {
		if (!selectedPath) return;
		if (viewMode === 'diff') {
			untrack(() => {
				if (diffText === '' && !diffLoading && !diffError && selectedPath) {
					loadDiff(selectedPath);
				}
			});
		}
	});

	async function loadCommit(sha: string) {
		const requestSeq = ++commitRequestSeq;
		commitAbortController?.abort();
		commitFileDiffAbortController?.abort();
		commitFileDiffRequestSeq++;
		const controller = new AbortController();
		commitAbortController = controller;
		selectedSha = sha;
		commitDetail = null;
		commitDetailError = null;
		commitFilePath = null;
		commitFileDiff = '';
		try {
			const commitParams = worktreeParams(worktree);
			const commitQuery = commitParams.size > 0 ? `?${commitParams}` : '';
			const res = await fetch(
				`/api/conversations/${conversationId}/git/commit/${sha}${commitQuery}`,
				{
					signal: controller.signal
				}
			);
			if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
			const data = (await res.json()) as { commit: CommitDetail };
			if (requestSeq !== commitRequestSeq || controller.signal.aborted || selectedSha !== sha)
				return;
			commitDetail = data.commit;
		} catch (e) {
			if (requestSeq !== commitRequestSeq || controller.signal.aborted || isAbortError(e)) return;
			commitDetailError = e instanceof Error ? e.message : String(e);
		} finally {
			if (requestSeq === commitRequestSeq && commitAbortController === controller) {
				commitAbortController = null;
			}
		}
	}

	async function loadCommitFileDiff(path: string) {
		if (!selectedSha) return;
		const sha = selectedSha;
		const requestSeq = ++commitFileDiffRequestSeq;
		commitFileDiffAbortController?.abort();
		const controller = new AbortController();
		commitFileDiffAbortController = controller;
		commitFilePath = path;
		commitFileDiff = '';
		try {
			const params = worktreeParams(worktree, {
				target: 'commit-vs-parent',
				sha,
				path
			});
			const res = await fetch(`/api/conversations/${conversationId}/fs/diff?${params}`, {
				signal: controller.signal
			});
			if (!res.ok) throw new Error(await res.text());
			const data = (await res.json()) as { diff: string };
			if (
				requestSeq !== commitFileDiffRequestSeq ||
				controller.signal.aborted ||
				selectedSha !== sha ||
				commitFilePath !== path
			) {
				return;
			}
			commitFileDiff = data.diff;
		} catch (e) {
			if (requestSeq !== commitFileDiffRequestSeq || controller.signal.aborted || isAbortError(e))
				return;
			commitFileDiff = `Failed to load diff: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			if (requestSeq === commitFileDiffRequestSeq && commitFileDiffAbortController === controller) {
				commitFileDiffAbortController = null;
			}
		}
	}

	function fmtSize(n: number | null | undefined): string {
		if (n == null) return '';
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
	}

	// --- Code review feedback ----------------------------------------------
	$effect(() => {
		reviewStore.setConversation(conversationId);
	});

	let draft = $state<ReviewLocation | null>(null);
	let draftBody = $state('');
	let reviewListOpen = $state(false);

	const reviewComments = $derived(reviewStore.comments);
	const commentedKeys = $derived(reviewStore.commentedKeys);

	const contentLines = $derived(
		fileData && !fileData.binary && typeof fileData.content === 'string'
			? fileData.content.replace(/\n$/u, '').split('\n')
			: []
	);
	const contentLanguage = $derived(languageForPath(selectedPath));
	let highlightedContent = $state<HighlightedLines | null>(null);
	let highlightRequestSeq = 0;

	$effect(() => {
		const path = selectedPath;
		const lines = contentLines;
		const language = contentLanguage;
		const seq = ++highlightRequestSeq;
		highlightedContent = null;
		if (!path || lines.length === 0) return;
		void highlightCodeLines(lines, language).then((result) => {
			if (seq === highlightRequestSeq && selectedPath === path) {
				highlightedContent = result;
			}
		});
	});

	function highlightedContentLine(text: string, idx: number): string {
		return highlightedContent?.html[idx] ?? escapeHtml(text);
	}

	// URL for an inline image preview of the selected worktree file. Only set
	// when the server flagged the binary file as a renderable image; the bytes
	// are served (authed) by the `fs/file?raw=1` mode.
	const imageSrc = $derived.by(() => {
		if (!fileData || !fileData.binary || !fileData.imageMimeType || !selectedPath) return null;
		const params = worktreeParams(worktree, { path: selectedPath, raw: '1' });
		return `/api/conversations/${conversationId}/fs/file?${params}`;
	});

	// Natural pixel dimensions of the previewed image, read from the <img> once
	// it loads. Surfaced in a caption so tiny images (e.g. a 1×1) are obviously
	// present rather than looking like an empty pane.
	let imageDims = $state<{ w: number; h: number } | null>(null);
	$effect(() => {
		// Reset whenever the previewed source changes so the caption never shows
		// stale dimensions from a previously selected image.
		void imageSrc;
		imageDims = null;
	});

	function startComment(location: ReviewLocation) {
		draft = location;
		draftBody = '';
	}

	function cancelComment() {
		draft = null;
		draftBody = '';
	}

	function saveComment() {
		if (!draft) return;
		if (reviewStore.add(draft, draftBody)) {
			draft = null;
			draftBody = '';
		}
	}

	function sendReview() {
		if (reviewStore.sendToComposer()) {
			reviewListOpen = false;
			onSendToChat?.();
		}
	}

	function locationSummary(loc: ReviewLocation): string {
		const where = loc.lineNo == null ? '' : `:${loc.lineNo}`;
		return `${loc.path}${where}`;
	}
</script>

<div class="browser">
	<div class="left">
		<GitStatusHeader
			{conversationId}
			{worktree}
			refreshToken={gitRefreshToken}
			onrevert={clearSelectionAndRefresh}
		/>
		{#if pane === 'files'}
			<div class="pane-body">
				<FileTree
					{conversationId}
					{worktree}
					{selectedPath}
					bind:showHidden
					bind:showIgnored
					onselect={pickFile}
					onrefresh={bumpGitRefresh}
				/>
			</div>
		{:else if pane === 'changes'}
			<div class="pane-body">
				<ChangeList
					{conversationId}
					{worktree}
					{selectedPath}
					refreshToken={gitRefreshToken}
					onselect={pickChange}
					onrefresh={bumpGitRefresh}
				/>
			</div>
		{:else}
			<div class="pane-body">
				<CommitList {conversationId} {worktree} {selectedSha} onselect={loadCommit} />
			</div>
		{/if}
	</div>

	<div class="right">
		{#if pane === 'commits' && selectedSha}
			<div class="header">
				<div class="title">
					<code class="sha">{commitDetail?.shortSha ?? selectedSha.slice(0, 8)}</code>
					<span>{commitDetail?.subject ?? 'Loading…'}</span>
				</div>
				{#if commitDetail}
					<div class="muted small">
						{commitDetail.author} · {new Date(commitDetail.timestamp).toLocaleString()}
					</div>
				{/if}
			</div>
			<div class="commit-body">
				{#if commitDetailError}
					<div class="error-wrap"><Alert kind="error">{commitDetailError}</Alert></div>
				{:else if commitDetail}
					{#if commitDetail.body}
						<pre class="commit-message">{commitDetail.body}</pre>
					{/if}
					<div class="files-grid">
						<div class="commit-files">
							{#each commitDetail.files as f (f.path)}
								<button
									class="commit-file"
									class:selected={commitFilePath === f.path}
									onclick={() => loadCommitFileDiff(f.path)}
								>
									<StatusBadge status={f.status} />
									<span class="path">{f.path}</span>
								</button>
							{/each}
						</div>
						<div class="commit-diff">
							{#if commitFilePath}
								<DiffView
									path={commitFilePath}
									diff={commitFileDiff || 'Loading…'}
									commentable
									commentSha={selectedSha}
									{commentedKeys}
									onLineClick={startComment}
								/>
							{:else}
								<EmptyState size="sm" description="Select a file to see its diff." />
							{/if}
						</div>
					</div>
				{:else}
					<EmptyState size="sm" description="Loading commit…" />
				{/if}
			</div>
		{:else if selectedPath}
			<div class="header">
				<div class="title">
					<code class="path">{selectedPath}</code>
					{#if selectedStatus}
						<StatusBadge status={selectedStatus} />
					{/if}
				</div>
				<div class="view-tabs" role="tablist">
					<button
						role="tab"
						aria-selected={viewMode === 'content'}
						class:active={viewMode === 'content'}
						onclick={() => (viewMode = 'content')}
					>
						Content
					</button>
					<button
						role="tab"
						aria-selected={viewMode === 'diff'}
						class:active={viewMode === 'diff'}
						onclick={() => {
							viewMode = 'diff';
							if (selectedPath && diffText === '') loadDiff(selectedPath);
						}}
						disabled={!selectedStatus ||
							selectedStatus === 'untracked' ||
							selectedStatus === 'ignored'}
						title={!selectedStatus
							? 'File is unchanged'
							: selectedStatus === 'untracked'
								? 'File is untracked'
								: ''}
					>
						Diff
					</button>
				</div>
			</div>
			<div class="content-body">
				{#if viewMode === 'content'}
					{#if fileLoading}
						<EmptyState size="sm" description="Loading…" />
					{:else if fileError}
						<div class="error-wrap"><Alert kind="error">{fileError}</Alert></div>
					{:else if fileData?.binary}
						{#if imageSrc}
							<div class="image-preview">
								<img
									src={imageSrc}
									alt={selectedPath ?? 'image preview'}
									onload={(e) => {
										const el = e.currentTarget as HTMLImageElement;
										imageDims = { w: el.naturalWidth, h: el.naturalHeight };
									}}
								/>
								<div class="image-caption">
									{#if imageDims}{imageDims.w} × {imageDims.h} px ·
									{/if}{(fileData as { imageMimeType?: string })
										.imageMimeType}{#if (fileData as { size?: number }).size != null}
										· {fmtSize((fileData as { size?: number }).size ?? null)}{/if}
								</div>
							</div>
						{:else}
							<EmptyState
								size="sm"
								description={`Binary file (${fmtSize((fileData as { size?: number }).size ?? null)}).`}
							/>
						{/if}
					{:else if fileData}
						{#if contentLines.length > 0}
							<div class="file-view commentable" role="table" aria-label="file lines">
								{#each contentLines as text, idx (idx)}
									{@const lineNo = idx + 1}
									{@const loc = {
										path: selectedPath,
										side: 'file' as const,
										lineNo,
										lineText: text,
										sha: null
									}}
									{@const commented = commentedKeys.has(lineKey(loc))}
									<div class="file-line" class:commented role="row">
										<button
											type="button"
											class="comment-add"
											title={commented ? 'Line has a review comment' : 'Add review comment'}
											aria-label={commented ? 'Line has a review comment' : 'Add review comment'}
											onclick={() => startComment(loc)}
										>
											{commented ? '●' : '+'}
										</button>
										<span class="gutter" role="cell" aria-label="line number">{lineNo}</span>
										<!-- Safe: highlightedContentLine returns either escapeHtml()
										     output or highlight.js markup, which escapes the source
										     text it wraps. No file content reaches the DOM unescaped. -->
										<!-- eslint-disable-next-line svelte/no-at-html-tags -->
										<span class="text" role="cell">{@html highlightedContentLine(text, idx)}</span>
									</div>
								{/each}
							</div>
							{#if highlightedContent?.skipped}
								<div class="muted small truncated-note">
									Syntax highlighting skipped for this large file.
								</div>
							{/if}
						{:else}
							<pre class="file-view">{fileData.content}</pre>
						{/if}
						{#if fileData.truncated}
							<div class="muted small truncated-note">
								File truncated at 1 MiB (real size: {fmtSize(fileData.size)}).
							</div>
						{/if}
					{/if}
				{:else if diffLoading}
					<EmptyState size="sm" description="Loading diff…" />
				{:else if diffError}
					<div class="error-wrap"><Alert kind="error">{diffError}</Alert></div>
				{:else if diffText}
					<DiffView
						path={selectedPath}
						diff={diffText}
						commentable
						{commentedKeys}
						onLineClick={startComment}
					/>
				{:else}
					<EmptyState size="sm" description="No changes for this file." />
				{/if}
			</div>
		{:else}
			<EmptyState size="sm" description="Select a file or commit to view it." />
		{/if}

		{#if draft}
			<div class="review-draft">
				<div class="review-draft-head">
					<span class="muted small">Review comment on</span>
					<code class="loc">{locationSummary(draft)}</code>
				</div>
				{#if draft.lineText.trim()}
					<pre class="review-line">{draft.lineText}</pre>
				{/if}
				<textarea
					class="review-input"
					bind:value={draftBody}
					rows="3"
					placeholder="Leave feedback for this line…"
					onkeydown={(e) => {
						if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							saveComment();
						} else if (e.key === 'Escape') {
							e.preventDefault();
							cancelComment();
						}
					}}></textarea>
				<div class="review-draft-actions">
					<span class="kbd-hint muted small">⌘/Ctrl+Enter to add</span>
					<button class="btn ghost" type="button" onclick={cancelComment}>Cancel</button>
					<button
						class="btn primary"
						type="button"
						disabled={!draftBody.trim()}
						onclick={saveComment}
					>
						Add comment
					</button>
				</div>
			</div>
		{/if}

		{#if reviewComments.length > 0}
			<div class="review-bar">
				<button
					class="review-summary"
					type="button"
					aria-expanded={reviewListOpen}
					onclick={() => (reviewListOpen = !reviewListOpen)}
				>
					<span class="chevron" class:open={reviewListOpen} aria-hidden="true">▸</span>
					{reviewComments.length} review comment{reviewComments.length === 1 ? '' : 's'}
				</button>
				<div class="review-bar-actions">
					<button class="btn ghost" type="button" onclick={() => reviewStore.clear()}>Clear</button>
					<button class="btn primary" type="button" onclick={sendReview}>Send to chat</button>
				</div>
			</div>
			{#if reviewListOpen}
				<div class="review-list">
					{#each reviewComments as c (c.id)}
						<div class="review-item">
							<div class="review-item-head">
								<code class="loc">{locationSummary(c)}</code>
								<button
									class="review-remove"
									type="button"
									aria-label="Remove comment"
									title="Remove comment"
									onclick={() => reviewStore.remove(c.id)}>×</button
								>
							</div>
							<div class="review-item-body">{c.body}</div>
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	.browser {
		display: grid;
		grid-template-columns: minmax(220px, 320px) 1fr;
		height: 100%;
		min-height: 0;
		gap: 0;
	}
	.left {
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
		border-right: 1px solid var(--border);
		background: var(--surface);
		overflow: hidden;
	}
	.right {
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
	}
	.view-tabs {
		display: flex;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}
	.view-tabs button {
		background: transparent;
		color: var(--text-muted);
		border: 0;
		border-bottom: 2px solid transparent;
		padding: var(--space-2) var(--space-3);
		cursor: pointer;
		font: inherit;
		flex: 0 0 auto;
	}
	.view-tabs button.active {
		color: var(--text);
		border-bottom-color: var(--accent);
	}
	.view-tabs button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.pane-body {
		flex: 1;
		min-height: 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.header {
		padding: var(--space-2) var(--space-3);
		border-bottom: 1px solid var(--border);
		background: var(--surface);
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.title {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.title .path,
	.title .sha {
		font-family: var(--mono);
		font-size: var(--fs-md);
	}
	.view-tabs {
		margin-top: 0;
	}
	.content-body,
	.commit-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.content-body {
		padding: var(--space-3);
		gap: var(--space-2);
	}
	.commit-message {
		margin: 0;
		padding: var(--space-3);
		background: var(--surface-2);
		border-bottom: 1px solid var(--border);
		font-family: var(--mono);
		font-size: var(--fs-sm);
		white-space: pre-wrap;
	}
	.files-grid {
		display: grid;
		grid-template-columns: minmax(220px, 320px) 1fr;
		flex: 1;
		min-height: 0;
		gap: 0;
		border-top: 1px solid var(--border);
	}
	.commit-files {
		overflow: auto;
		border-right: 1px solid var(--border);
		background: var(--surface);
		min-height: 0;
		min-width: 0;
	}
	.commit-file {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		min-width: 0;
		text-align: left;
		background: transparent;
		color: var(--text);
		border: 0;
		padding: var(--space-1) var(--space-3);
		font: inherit;
		cursor: pointer;
	}
	.commit-file:hover {
		background: var(--surface-hover);
	}
	.commit-file.selected {
		background: var(--surface-2);
		outline: 1px solid var(--accent);
		outline-offset: -1px;
	}
	.commit-file .path {
		flex: 1 1 auto;
		min-width: 0;
		font-family: var(--mono);
		font-size: var(--fs-sm);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.commit-diff {
		overflow: auto;
		min-height: 0;
		padding: var(--space-2);
	}
	.file-view {
		margin: 0;
		flex: 1;
		min-height: 0;
		font-family: var(--mono);
		font-size: var(--code-fs);
		white-space: pre;
		overflow: auto;
		background: var(--bg);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
	}
	.image-preview {
		flex: 1;
		min-height: 0;
		overflow: auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-start;
		gap: var(--space-2);
		padding: var(--space-3);
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
	}
	.image-preview img {
		max-width: 100%;
		height: auto;
		object-fit: contain;
		image-rendering: auto;
		background: repeating-conic-gradient(var(--surface-2) 0% 25%, transparent 0% 50%) 50% / 20px
			20px;
	}
	.image-caption {
		flex: none;
		font-size: var(--fs-sm);
		color: var(--text-muted);
		text-align: center;
	}
	.file-view.commentable {
		padding: var(--space-2) 0;
		white-space: normal;
		line-height: 1.45;
	}
	.file-line {
		display: grid;
		grid-template-columns: 1.5em 3.5em max-content;
		align-items: baseline;
		white-space: pre;
		min-width: 100%;
		width: max-content;
	}
	.file-line .comment-add {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5em;
		align-self: stretch;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--accent);
		font: inherit;
		line-height: 1;
		cursor: pointer;
		opacity: 0;
		user-select: none;
	}
	.file-line:hover .comment-add {
		opacity: 0.7;
	}
	.file-line .comment-add:hover {
		opacity: 1;
		background: color-mix(in srgb, var(--accent) 18%, transparent);
	}
	.file-line.commented .comment-add {
		opacity: 1;
	}
	.file-line .gutter {
		text-align: right;
		padding: 0 0.45rem;
		color: var(--text-muted);
		user-select: none;
		font-variant-numeric: tabular-nums;
	}
	.file-line.commented .gutter {
		box-shadow: inset 2px 0 0 var(--accent);
	}
	.file-line .text {
		padding: 0 0.4rem;
		white-space: pre;
	}
	.review-draft {
		border-top: 1px solid var(--border);
		background: var(--surface);
		padding: var(--space-2) var(--space-3);
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.review-draft-head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.review-draft .loc,
	.review-item .loc {
		font-family: var(--mono);
		font-size: var(--fs-sm);
		color: var(--accent);
	}
	.review-line {
		margin: 0;
		padding: var(--space-1) var(--space-2);
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		font-family: var(--mono);
		font-size: var(--fs-sm);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		max-height: 6em;
		overflow: auto;
	}
	.review-input {
		width: 100%;
		resize: vertical;
		font: inherit;
		padding: var(--space-2);
		background: var(--bg);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}
	.review-input:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: var(--focus-ring);
	}
	.review-draft-actions,
	.review-bar-actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		justify-content: flex-end;
	}
	.review-draft-actions .kbd-hint {
		margin-right: auto;
	}
	.btn {
		font: inherit;
		padding: var(--space-1) var(--space-3);
		border-radius: var(--radius-md);
		border: 1px solid var(--border);
		cursor: pointer;
		background: var(--surface-2);
		color: var(--text);
	}
	.btn.primary {
		background: var(--accent);
		color: var(--accent-text);
		border-color: transparent;
	}
	.btn.primary:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.btn.ghost {
		background: transparent;
	}
	.btn:hover:not(:disabled) {
		filter: brightness(1.05);
	}
	.review-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		border-top: 1px solid var(--border);
		background: var(--surface-2);
		padding: var(--space-2) var(--space-3);
	}
	.review-summary {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		background: transparent;
		border: 0;
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}
	.review-summary .chevron {
		transition: transform 0.12s ease;
	}
	.review-summary .chevron.open {
		transform: rotate(90deg);
	}
	.review-list {
		max-height: 14rem;
		overflow: auto;
		border-top: 1px solid var(--border);
		background: var(--surface);
	}
	.review-item {
		padding: var(--space-2) var(--space-3);
		border-bottom: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.review-item-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.review-remove {
		background: transparent;
		border: 0;
		color: var(--text-muted);
		cursor: pointer;
		font-size: var(--fs-xl);
		line-height: 1;
		padding: 0 var(--space-1);
	}
	.review-remove:hover {
		color: var(--danger);
	}
	.review-item-body {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: var(--fs-sm);
	}
	.error-wrap {
		padding: var(--space-2) var(--space-3);
	}
	.muted {
		color: var(--text-muted);
	}
	.small {
		font-size: var(--fs-sm);
	}
	.truncated-note {
		margin-top: 0.3rem;
	}
	@media (max-width: 768px) {
		.browser {
			grid-template-columns: 1fr;
			grid-template-rows: minmax(180px, 40%) 1fr;
		}
		.left {
			border-right: 0;
			border-bottom: 1px solid var(--border);
		}
		.files-grid {
			grid-template-columns: 1fr;
			grid-template-rows: minmax(120px, 35%) 1fr;
		}
		.commit-files {
			border-right: 0;
			border-bottom: 1px solid var(--border);
		}
	}
</style>
