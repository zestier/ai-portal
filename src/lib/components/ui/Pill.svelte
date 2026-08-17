<script lang="ts">
  import type { Snippet } from "svelte";
  type Tone = "neutral" | "accent" | "success" | "warning" | "danger";
  let { tone = "neutral", children }: { tone?: Tone; children: Snippet } =
    $props();
</script>

<span class="pill" data-tone={tone}>{@render children()}</span>

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-pill);
    border: 1px solid var(--border);
    background: var(--surface-2);
    font-size: var(--fs-xs);
    line-height: 1.5;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .pill[data-tone="accent"] {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
    background: var(--accent-bg);
  }
  .pill[data-tone="success"] {
    color: var(--success);
    border-color: color-mix(in srgb, var(--success) 45%, var(--border));
    background: var(--success-bg);
  }
  .pill[data-tone="warning"] {
    color: var(--warning);
    border-color: color-mix(in srgb, var(--warning) 45%, var(--border));
    background: var(--warning-bg);
  }
  .pill[data-tone="danger"] {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
    background: var(--danger-bg);
  }
</style>
