<script lang="ts">
  import type { Snippet } from "svelte";
  let {
    title,
    description,
    actions,
    size = "md",
  }: {
    title?: string;
    description?: string;
    actions?: Snippet;
    size?: "sm" | "md" | "lg";
  } = $props();
</script>

<div class="empty" data-size={size}>
  {#if title}<h2>{title}</h2>{/if}
  {#if description}<p class="muted">{description}</p>{/if}
  {#if actions}
    <div class="actions">{@render actions()}</div>
  {/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-6) var(--space-4);
    text-align: center;
  }
  .empty[data-size="sm"] {
    padding: var(--space-3) var(--space-2);
    gap: var(--space-2);
  }
  .empty[data-size="lg"] {
    padding: var(--space-6) var(--space-5);
  }
  h2 {
    margin: 0;
    font-size: var(--fs-xl);
  }
  p {
    margin: 0;
    max-width: 32rem;
  }
  .actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    justify-content: center;
  }
</style>
