<script lang="ts">
	import { renderMarkdown } from '$lib/client/markdown';
	import { copyableCodeBlocks } from '$lib/client/copyable-code-blocks';
	import type { ResultBlock } from '$lib/client/tool-result';
	import TerminalBlock from './TerminalBlock.svelte';

	let {
		block,
		command,
		markdown = false
	}: { block: ResultBlock; command?: string; markdown?: boolean } = $props();

	const markdownHtml = $derived(
		block.kind === 'text' && markdown ? renderMarkdown(block.text) : null
	);
</script>

{#if block.kind === 'terminal'}
	<TerminalBlock text={block.text} cwd={block.cwd} exitCode={block.exitCode} {command} />
{:else if block.kind === 'text' && command}
	<TerminalBlock text={block.text} {command} />
{:else if block.kind === 'text' && markdownHtml}
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	<div class="markdown-result" use:copyableCodeBlocks>{@html markdownHtml}</div>
{:else if block.kind === 'image'}
	<img class="image" src={`data:${block.mimeType};base64,${block.data}`} alt="tool output" />
{:else if block.kind === 'audio'}
	<audio controls src={`data:${block.mimeType};base64,${block.data}`}></audio>
{:else if block.kind === 'resource_link'}
	<a class="resource-link" href={block.uri} target="_blank" rel="noopener noreferrer">
		{block.name}{block.description ? ` — ${block.description}` : ''}
	</a>
{:else if block.kind === 'resource'}
	<div class="resource">
		<a href={block.uri} target="_blank" rel="noopener noreferrer"><code>{block.uri}</code></a>
		{#if block.text}<div use:copyableCodeBlocks><pre><code>{block.text}</code></pre></div>{/if}
	</div>
{:else}
	<div use:copyableCodeBlocks><pre><code>{block.text}</code></pre></div>
{/if}

<style>
	.image {
		max-width: 100%;
		max-height: 32em;
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
