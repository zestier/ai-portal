<script lang="ts">
  import type { TranscriptEntry } from "$lib/client/transcript-store";
  import type { TranscriptRecordDescriptor } from "$lib/types";

  // Compact row for a message whose full body isn't mounted (windowed
  // rendering): role + status + plain-text preview + record summary chips.
  // Heavy markdown/tool cards stay bounded to the viewport window; these
  // rows keep the scrollbar honest and the transcript readable while
  // scrolling a long thread.
  let {
    entry,
    onHydrate = null,
  }: {
    entry: TranscriptEntry;
    onHydrate?: (() => void) | null;
  } = $props();

  const MAX_CHIPS = 6;

  const chips = $derived(
    entry.records.slice(0, MAX_CHIPS).map((d) => chipLabel(d)),
  );
  const moreCount = $derived(entry.records.length - MAX_CHIPS);

  function chipLabel(d: TranscriptRecordDescriptor): string {
    switch (d.kind) {
      case "tool":
        return `${d.tool} · ${d.summary}`;
      case "edit":
        return `✎ ${d.summary}`;
      case "reasoning":
        return d.reasoningKind === "content"
          ? `💬 ${d.summary}`
          : `🤔 ${d.summary}`;
    }
  }

  function roleIcon(role: string): string {
    if (role === "user") return "🧑";
    if (role === "system") return "⚙️";
    return "🤖";
  }

  function statusLabel(status: string): string {
    switch (status) {
      case "streaming":
        return "streaming…";
      case "interrupted":
        return "interrupted";
      case "error":
        return "error";
      default:
        return "";
    }
  }

  function relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000)
      return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
    return new Date(ts).toLocaleDateString();
  }
</script>

<div
  class="index-row"
  data-role={entry.role}
  data-testid="transcript-index-row"
>
  <span class="role">{roleIcon(entry.role)} {entry.role}</span>
  {#if statusLabel(entry.status)}
    <span class="status muted">{statusLabel(entry.status)}</span>
  {/if}
  <span class="time muted">{relativeTime(entry.createdAt)}</span>
  {#if onHydrate}
    <button
      type="button"
      class="expand"
      onclick={onHydrate}
      aria-label="Load this message in full"
      title="Load this message in full"
    >
      Load
    </button>
  {/if}
  {#if entry.preview}
    <p class="preview">{entry.preview}</p>
  {/if}
  {#if chips.length > 0}
    <div class="chips">
      {#each chips as c, i (i)}
        <span class="chip muted">{c}</span>
      {/each}
      {#if moreCount > 0}
        <span class="chip muted">+{moreCount} more</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .index-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--border);
    border-left-width: 3px;
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--surface) 60%, transparent);
  }
  @media (max-width: 768px) {
    .index-row {
      padding: var(--space-2) var(--space-3);
    }
  }
  .preview {
    flex-basis: 100%;
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--text);
    opacity: 0.85;
    display: -webkit-box;
    line-clamp: 2;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .expand {
    margin-left: auto;
    padding: 0.15rem 0.5rem;
    font: inherit;
    font-size: var(--fs-xs);
    color: var(--text-muted);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    cursor: pointer;
  }
  .expand:hover {
    color: var(--text);
    background: var(--surface-hover);
  }
  .preview {
    flex-basis: 100%;
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--text);
    opacity: 0.85;
    display: -webkit-box;
    line-clamp: 2;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    flex-basis: 100%;
  }
  .chip {
    font-size: var(--fs-xs);
    padding: 0.1rem 0.45rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    background: var(--surface);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 22em;
  }
</style>
