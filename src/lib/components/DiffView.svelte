<script lang="ts">
	import { splitUnifiedDiffByFile } from '$lib/client/diff-synth';
	import {
		MAX_RENDERABLE_DIFF_CHARS,
		isRenderableDiff,
		parseUnifiedDiff,
		diffStats,
		type DiffLine
	} from '$lib/client/diff-parser';
	import { lineKey, type ReviewLocation } from '$lib/client/review-format';
	import {
		escapeHtml,
		highlightCodeLines,
		languageForPath,
		type HighlightedLines
	} from '$lib/client/syntax-highlight';
	import EmptyState from './ui/EmptyState.svelte';

	let {
		path = 'diff',
		diff,
		showLineNumbers = true,
		collapsible = false,
		commentable = false,
		commentSha = null,
		commentedKeys,
		onLineClick
	}: {
		path?: string;
		diff: string;
		showLineNumbers?: boolean;
		collapsible?: boolean;
		/** When true, each code line gets an affordance to attach a review comment. */
		commentable?: boolean;
		/** Commit SHA, when the diff is for a specific commit. */
		commentSha?: string | null;
		/** Keys (see review-format `lineKey`) of lines that already have a comment. */
		commentedKeys?: Set<string>;
		onLineClick?: (location: ReviewLocation) => void;
	} = $props();

	function lineLocation(chunkPath: string, l: DiffLine): ReviewLocation | null {
		if (l.kind === 'add' || l.kind === 'context') {
			return { path: chunkPath, side: 'new', lineNo: l.newNo, lineText: l.text, sha: commentSha };
		}
		if (l.kind === 'del') {
			return { path: chunkPath, side: 'old', lineNo: l.oldNo, lineText: l.text, sha: commentSha };
		}
		return null;
	}

	const chunks = $derived.by(() => {
		if (!isRenderableDiff(diff)) return [];
		const split = splitUnifiedDiffByFile(diff, path);
		return split.length > 0 ? split : [{ path, diff }];
	});
	const parsedChunks = $derived.by(() =>
		chunks.map((chunk, chunkIndex) => {
			const parsed = parseUnifiedDiff(chunk.diff);
			return {
				...chunk,
				chunkIndex,
				key: chunkKey(chunk.path, chunkIndex),
				parsed,
				stats: diffStats(parsed),
				empty: parsed.length === 0 || parsed.every((l) => l.kind === 'meta'),
				language: languageForPath(chunk.path)
			};
		})
	);
	const tooLarge = $derived(!isRenderableDiff(diff));
	let collapsedFiles = $state<Record<string, boolean>>({});
	let highlightedChunks = $state<Record<string, HighlightedLines>>({});
	let highlightRequestSeq = 0;

	$effect(() => {
		const chunksToHighlight = parsedChunks;
		const seq = ++highlightRequestSeq;
		highlightedChunks = {};
		for (const chunk of chunksToHighlight) {
			const lines = chunk.parsed.map((line) => line.text);
			void highlightCodeLines(lines, chunk.language).then((result) => {
				if (seq !== highlightRequestSeq) return;
				highlightedChunks = { ...highlightedChunks, [chunk.key]: result };
			});
		}
	});

	function fmtNo(n: number | null): string {
		return n == null ? '' : String(n);
	}

	function chunkKey(chunkPath: string, chunkIndex: number): string {
		return `${chunkPath}:${chunkIndex}`;
	}

	function toggleCollapsed(key: string) {
		collapsedFiles = { ...collapsedFiles, [key]: !collapsedFiles[key] };
	}

	// Only real code lines are highlighted: meta and hunk headers keep their
	// literal text so the diff's own structure is never restyled away.
	function highlightedDiffLine(chunkKey: string, line: DiffLine, idx: number): string {
		if (line.kind !== 'add' && line.kind !== 'del' && line.kind !== 'context') {
			return escapeHtml(line.text);
		}
		return highlightedChunks[chunkKey]?.html[idx] ?? escapeHtml(line.text);
	}
</script>

<div class="diff-set">
	{#if tooLarge}
		<div class="diff-too-large">
			Diff is too large to render safely ({diff.length.toLocaleString()} characters; limit
			{MAX_RENDERABLE_DIFF_CHARS.toLocaleString()}).
		</div>
	{/if}
	{#each parsedChunks as chunk (chunk.key)}
		{@const key = chunk.key}
		{@const collapsed = collapsible && collapsedFiles[key] === true}
		<div class="diff" class:collapsed>
			<div class="path-bar">
				{#if collapsible}
					<button
						type="button"
						class="collapse-toggle"
						aria-expanded={!collapsed}
						aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${chunk.path}`}
						onclick={() => toggleCollapsed(key)}
					>
						<span class="chevron" class:open={!collapsed} aria-hidden="true">▸</span>
					</button>
				{/if}
				<code class="path">{chunk.path}</code>
				<span class="stats">
					<span class="added">+{chunk.stats.added}</span>
					<span class="removed">−{chunk.stats.removed}</span>
				</span>
			</div>
			{#if !collapsed}
				{#if chunk.empty}
					<EmptyState
						size="sm"
						description="No textual diff (file may be binary, empty, or unchanged)."
					/>
				{:else}
					<div
						class="lines"
						class:no-gutter={!showLineNumbers}
						class:commentable
						role="table"
						aria-label="diff lines"
					>
						<div class="rows">
							{#each chunk.parsed as l, i (i)}
								{#if l.kind === 'hunk' && !showLineNumbers}
									<!-- Suppress the @@ -L,N +L,N @@ header when we don't trust the
									     line ranges (e.g. for diffs synthesized from edit args
									     without full-file context). -->
								{:else}
									{@const loc = commentable ? lineLocation(chunk.path, l) : null}
									{@const commented =
										loc != null && commentedKeys ? commentedKeys.has(lineKey(loc)) : false}
									<div class={'line ' + l.kind} class:commented role="row">
										{#if commentable}
											{#if loc && loc.lineNo != null}
												<button
													type="button"
													class="comment-add"
													title={commented ? 'Line has a review comment' : 'Add review comment'}
													aria-label={commented
														? 'Line has a review comment'
														: 'Add review comment'}
													onclick={() => onLineClick?.(loc)}
												>
													{commented ? '●' : '+'}
												</button>
											{:else}
												<span class="comment-add placeholder" aria-hidden="true"></span>
											{/if}
										{/if}
										{#if showLineNumbers}
											<span class="gutter" role="cell" aria-label="line number"
												>{fmtNo(l.newNo ?? l.oldNo)}</span
											>
										{/if}
										<span class="sign" aria-hidden="true"
											>{l.kind === 'add'
												? '+'
												: l.kind === 'del'
													? '-'
													: l.kind === 'hunk'
														? '@'
														: ' '}</span
										>
										<!-- Safe: every branch of highlightedDiffLine returns either
										     escapeHtml() output or highlight.js markup, which escapes
										     the source text it wraps. No file content reaches the DOM
										     unescaped. -->
										<!-- eslint-disable-next-line svelte/no-at-html-tags -->
										<span class="text" role="cell">{@html highlightedDiffLine(key, l, i)}</span>
									</div>
								{/if}
							{/each}
						</div>
					</div>
					{#if highlightedChunks[key]?.skipped}
						<div class="highlight-note">Syntax highlighting skipped for this large diff.</div>
					{/if}
				{/if}
			{/if}
		</div>
	{/each}
</div>

<style>
	.diff-set {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-height: 0;
	}
	.diff-too-large {
		padding: 0.75rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text-muted);
	}
	.highlight-note {
		padding: 0.35rem 0.6rem;
		border-top: 1px solid var(--border);
		background: var(--surface);
		color: var(--text-muted);
		font-size: var(--fs-sm);
	}
	.diff {
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg);
		overflow: hidden;
	}
	.path-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3rem 0.6rem;
		background: var(--surface-2);
		border-bottom: 1px solid var(--border);
		font-size: var(--fs-md);
		position: sticky;
		top: 0;
		z-index: var(--z-base);
	}
	.collapsed .path-bar {
		border-bottom: 0;
	}
	.collapse-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		padding: 0;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		flex: none;
	}
	.collapse-toggle:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	.chevron {
		transition: transform 0.12s ease;
	}
	.chevron.open {
		transform: rotate(90deg);
	}
	.path {
		font-family: var(--mono);
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.stats {
		display: inline-flex;
		gap: 0.4rem;
		font-family: var(--mono);
		font-size: var(--fs-lg);
	}
	.added {
		color: var(--success);
	}
	.removed {
		color: var(--danger);
	}
	.lines {
		flex: 1;
		min-height: 0;
		overflow: auto;
		font-family: var(--mono);
		font-size: var(--fs-sm);
		line-height: 1.45;
	}
	.rows {
		width: max-content;
		min-width: 100%;
	}
	.line {
		display: grid;
		grid-template-columns: 3.5em 1em max-content;
		align-items: baseline;
		white-space: pre;
	}
	.no-gutter .line {
		grid-template-columns: 1em max-content;
	}
	.commentable .line {
		grid-template-columns: 1.5em 3.5em 1em max-content;
	}
	.commentable.no-gutter .line {
		grid-template-columns: 1.5em 1em max-content;
	}
	.comment-add {
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
		transition: opacity 0.1s ease;
	}
	.comment-add.placeholder {
		cursor: default;
	}
	.line:hover .comment-add {
		opacity: 0.7;
	}
	.comment-add:hover {
		opacity: 1;
		background: color-mix(in srgb, var(--accent) 18%, transparent);
	}
	.line.commented .comment-add {
		opacity: 1;
		color: var(--accent);
	}
	.line.commented .gutter {
		box-shadow: inset 2px 0 0 var(--accent);
	}
	.gutter {
		text-align: right;
		padding: 0 0.45rem;
		color: var(--text-muted);
		background: var(--surface);
		border-right: 1px solid var(--border);
		user-select: none;
		font-variant-numeric: tabular-nums;
	}
	.sign {
		text-align: center;
		color: var(--text-muted);
		user-select: none;
	}
	.text {
		padding: 0 0.4rem;
		overflow-wrap: anywhere;
		white-space: pre;
	}
	.line.add .sign,
	.line.add .text {
		background: color-mix(in srgb, var(--success) 12%, transparent);
	}
	.line.add .text,
	.line.add .sign {
		color: var(--success);
	}
	.line.add .gutter {
		background: color-mix(in srgb, var(--success) 20%, transparent);
		color: var(--success);
	}
	.line.del .sign,
	.line.del .text {
		background: color-mix(in srgb, var(--danger) 12%, transparent);
	}
	.line.del .text,
	.line.del .sign {
		color: var(--danger);
	}
	.line.del .gutter {
		background: color-mix(in srgb, var(--danger) 20%, transparent);
		color: var(--danger);
	}
	.line.hunk {
		background: var(--surface);
		color: var(--text-muted);
	}
	.line.hunk .text {
		color: var(--text-muted);
	}
	.line.hunk .sign {
		color: var(--text-muted);
	}
	.line.meta {
		color: var(--text-muted);
		background: var(--surface);
	}
	.line.meta .text {
		color: var(--text-muted);
	}
	.line.nonewline {
		color: var(--text-muted);
		font-style: italic;
	}
</style>
