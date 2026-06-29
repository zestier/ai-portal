<script lang="ts">
	import { renderMarkdown } from '$lib/client/markdown';
	import { copyableCodeBlocks } from '$lib/client/copyable-code-blocks';
	import { zoomableImages } from '$lib/client/zoomable-images';
	import { openImageLightbox } from '$lib/client/image-lightbox.svelte';
	import type { ResultBlock } from '$lib/client/tool-result';
	import TerminalBlock from './TerminalBlock.svelte';

	let {
		block,
		command,
		markdown = false
	}: { block: ResultBlock; command?: string | undefined; markdown?: boolean } = $props();

	const markdownHtml = $derived(
		block.kind === 'text' && markdown ? renderMarkdown(block.text) : null
	);

	function safeHref(uri: string): string | null {
		const trimmed = uri.trim();
		if (trimmed.startsWith('#')) return trimmed;
		try {
			const scheme = new URL(trimmed).protocol.toLowerCase();
			if (scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:') {
				return trimmed;
			}
		} catch {
			/* not a parseable absolute URL */
		}
		return null;
	}

	const linkHref = $derived(
		block.kind === 'resource_link' || block.kind === 'resource' ? safeHref(block.uri) : null
	);
</script>

{#if block.kind === 'terminal'}
	<TerminalBlock text={block.text} cwd={block.cwd} exitCode={block.exitCode} {command} />
{:else if block.kind === 'text' && command}
	<TerminalBlock text={block.text} {command} />
{:else if block.kind === 'text' && markdownHtml}
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	<div class="markdown-result" use:copyableCodeBlocks use:zoomableImages>{@html markdownHtml}</div>
{:else if block.kind === 'image'}
	{@const imgSrc = block.src ?? `data:${block.mimeType};base64,${block.data}`}
	<button
		type="button"
		class="image-zoom"
		title="Click to view full size"
		onclick={() => openImageLightbox(imgSrc, 'tool output')}
	>
		<img class="image" src={imgSrc} alt="tool output" />
	</button>
{:else if block.kind === 'audio'}
	<audio controls src={`data:${block.mimeType};base64,${block.data}`}></audio>
{:else if block.kind === 'resource_link'}
	{#if linkHref}
		<a class="resource-link" href={linkHref} target="_blank" rel="noopener noreferrer">
			{block.name}{block.description ? ` — ${block.description}` : ''}
		</a>
	{:else}
		<span class="resource-link">
			{block.name}{block.description ? ` — ${block.description}` : ''} (<code>{block.uri}</code>)
		</span>
	{/if}
{:else if block.kind === 'resource'}
	<div class="resource">
		{#if linkHref}
			<a href={linkHref} target="_blank" rel="noopener noreferrer"><code>{block.uri}</code></a>
		{:else}
			<code>{block.uri}</code>
		{/if}
		{#if block.text}<div use:copyableCodeBlocks><pre><code>{block.text}</code></pre></div>{/if}
	</div>
{:else}
	<div use:copyableCodeBlocks><pre><code>{block.text}</code></pre></div>
{/if}

<style>
	.image-zoom {
		display: block;
		padding: 0;
		border: 0;
		background: none;
		cursor: zoom-in;
	}
	.image {
		max-width: 100%;
		height: auto;
		max-height: 24em;
		object-fit: contain;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		cursor: zoom-in;
	}
	.markdown-result :global(img) {
		display: block;
		max-width: 100%;
		height: auto;
		max-height: 24em;
		object-fit: contain;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}
	.resource-link {
		font-family: var(--mono);
		font-size: var(--fs-sm);
	}
	.resource pre {
		margin-top: 0.3rem;
	}
	pre {
		margin: 0;
		max-width: 100%;
		overflow-x: auto;
	}
	.markdown-result {
		font-size: var(--fs-md);
		line-height: 1.45;
	}
	.markdown-result :global(p:first-child) {
		margin-top: 0;
	}
	.markdown-result :global(p:last-child) {
		margin-bottom: 0;
	}
</style>
