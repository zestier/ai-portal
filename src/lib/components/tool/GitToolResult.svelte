<script lang="ts">
	import DiffView from '../DiffView.svelte';
	import type { GitRenderedResult } from '$lib/client/git-tool-result';

	let { result }: { result: GitRenderedResult } = $props();

	function formatDate(ms: number): string {
		return new Date(ms).toLocaleString();
	}

	function count(n: number | null): string {
		return n === null ? 'binary' : String(n);
	}

	function statFor(path: string) {
		return result.kind === 'commit-created'
			? result.fileStats.find((file) => file.path === path)
			: undefined;
	}

	function extraStats() {
		if (result.kind !== 'commit-created') return [];
		const shown = new Set(result.files.map((file) => file.path));
		return result.fileStats.filter((file) => !shown.has(file.path));
	}
</script>

{#if result.kind === 'diff-stat'}
	<div class="git-result">
		{#if result.total}
			<div class="summary">
				<span>{result.total.filesChanged} files</span>
				<span class="added">+{result.total.added}</span>
				<span class="removed">-{result.total.removed}</span>
			</div>
		{/if}
		<table>
			<thead>
				<tr><th>File</th><th>Added</th><th>Removed</th></tr>
			</thead>
			<tbody>
				{#each result.files as file}
					<tr>
						<td>
							<code>{file.path}</code>
							{#if file.origPath}<span class="muted"> from {file.origPath}</span>{/if}
						</td>
						<td class="num added">{count(file.added)}</td>
						<td class="num removed">{count(file.removed)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else if result.kind === 'diff-name-only'}
	<div class="git-result">
		<ul class="paths">
			{#each result.files as file}
				<li><code>{file}</code></li>
			{/each}
		</ul>
	</div>
{:else if result.kind === 'diff-name-status'}
	<div class="git-result">
		<table>
			<thead>
				<tr><th>Status</th><th>File</th></tr>
			</thead>
			<tbody>
				{#each result.files as file}
					<tr>
						<td><span class="status">{file.statusCode}</span></td>
						<td>
							<code>{file.path}</code>
							{#if file.origPath}<span class="muted"> from {file.origPath}</span>{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else if result.kind === 'log'}
	<div class="git-result">
		<table>
			<thead>
				<tr><th>Commit</th><th>Subject</th><th>Author</th><th>Date</th></tr>
			</thead>
			<tbody>
				{#each result.commits as commit}
					<tr>
						<td><code title={commit.sha}>{commit.shortSha}</code></td>
						<td>{commit.subject}</td>
						<td>{commit.author}</td>
						<td class="muted">{formatDate(commit.timestamp)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else if result.kind === 'commit'}
	<div class="git-result">
		<div class="commit-card">
			<div><code>{result.commit.shortSha}</code> {result.commit.subject}</div>
			<div class="muted">
				{result.commit.author} · {formatDate(result.commit.timestamp)}
			</div>
			{#if result.commit.body}<pre class="body">{result.commit.body}</pre>{/if}
		</div>
		<table>
			<thead>
				<tr><th>Status</th><th>File</th></tr>
			</thead>
			<tbody>
				{#each result.commit.files as file}
					<tr>
						<td><span class="status">{file.statusCode}</span></td>
						<td>
							<code>{file.path}</code>
							{#if file.origPath}<span class="muted"> from {file.origPath}</span>{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if result.commit.patch}
			<DiffView diff={result.commit.patch} collapsible />
		{/if}
	</div>
{:else if result.kind === 'commit-created'}
	<div class="git-result">
		<div class="commit-card">
			<div><code title={result.sha}>{result.shortSha}</code> {result.subject}</div>
			{#if result.diffStat}
				<div class="summary">
					<span>{result.diffStat.filesChanged} files</span>
					<span class="added">+{result.diffStat.added}</span>
					<span class="removed">-{result.diffStat.removed}</span>
				</div>
			{/if}
		</div>
		<div class="muted small">Created commit {result.sha}</div>
		{#if result.body}
			<div class="message-block">
				<div class="muted small">Body</div>
				<pre class="body">{result.body}</pre>
			</div>
		{/if}
		{#if result.trailers.length > 0}
			<table class="trailers">
				<thead>
					<tr><th>Trailer</th><th>Value</th></tr>
				</thead>
				<tbody>
					{#each result.trailers as trailer}
						<tr>
							<td><code>{trailer.token}</code></td>
							<td>{trailer.value}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
		<table>
			<thead>
				<tr><th>Status</th><th>File</th><th>Added</th><th>Removed</th></tr>
			</thead>
			<tbody>
				{#each result.files as file}
					{@const stat = statFor(file.path)}
					<tr>
						<td><span class="status">{file.statusCode}</span></td>
						<td>
							<code>{file.path}</code>
							{#if file.origPath}<span class="muted"> from {file.origPath}</span>{/if}
						</td>
						<td class="num added">{stat ? count(stat.added) : '—'}</td>
						<td class="num removed">{stat ? count(stat.removed) : '—'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if extraStats().length > 0}
			<details class="remaining">
				<summary class="muted">Additional diff stat entries: {extraStats().length}</summary>
				<table>
					<thead>
						<tr><th>File</th><th>Added</th><th>Removed</th></tr>
					</thead>
					<tbody>
						{#each extraStats() as file}
							<tr>
								<td>
									<code>{file.path}</code>
									{#if file.origPath}<span class="muted"> from {file.origPath}</span>{/if}
								</td>
								<td class="num added">{count(file.added)}</td>
								<td class="num removed">{count(file.removed)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</details>
		{/if}
		{#if result.remainingDirtyFiles.length > 0}
			<details class="remaining">
				<summary class="muted">
					Remaining dirty files: {result.remainingDirtyFiles.length}
				</summary>
				<ul class="paths">
					{#each result.remainingDirtyFiles as file}
						<li><span class="status">{file.statusCode}</span> <code>{file.path}</code></li>
					{/each}
				</ul>
			</details>
		{:else}
			<div class="muted">No remaining dirty files.</div>
		{/if}
	</div>
{/if}

<style>
	.git-result {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		font-size: var(--fs-sm);
	}
	.summary,
	.commit-card {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: baseline;
	}
	table {
		width: 100%;
		border-collapse: collapse;
	}
	th,
	td {
		padding: 0.25rem 0.4rem;
		border-bottom: 1px solid var(--border);
		text-align: left;
		vertical-align: top;
	}
	th {
		color: var(--text-muted);
		font-size: var(--eyebrow-fs);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: var(--eyebrow-ls);
	}
	.num {
		width: 5rem;
		text-align: right;
		font-family: var(--mono);
	}
	.added {
		color: var(--success, #3fb950);
	}
	.removed {
		color: var(--danger, #ff6b6b);
	}
	.status {
		font-family: var(--mono);
		font-weight: 600;
	}
	.muted {
		color: var(--text-muted);
	}
	.paths {
		margin: 0;
		padding-left: 1.2rem;
	}
	.remaining summary {
		cursor: pointer;
	}
	.small {
		font-size: var(--fs-xs);
	}
	.message-block {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.trailers {
		width: 100%;
		border-collapse: collapse;
	}
	.trailers th,
	.trailers td {
		padding: 0.25rem 0.4rem;
		border-bottom: 1px solid var(--border);
		text-align: left;
		vertical-align: top;
	}
	.body {
		width: 100%;
		margin: 0.2rem 0 0;
		white-space: pre-wrap;
		color: var(--text-muted);
	}
</style>
