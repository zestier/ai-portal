<script lang="ts">
  import type { ConversationUsage } from "$lib/types";

  let {
    usage,
  }: {
    usage: ConversationUsage | null;
  } = $props();

  const pct = $derived.by(() => {
    if (usage?.percentage !== undefined) return Math.min(100, usage.percentage);
    if (!usage || usage.tokenLimit <= 0) return 0;
    return Math.min(100, (usage.currentTokens / usage.tokenLimit) * 100);
  });

  const level = $derived.by<"low" | "mid" | "high">(() => {
    if (pct >= 90) return "high";
    if (pct >= 70) return "mid";
    return "low";
  });

  function fmt(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }
</script>

{#if usage}
  <div class="meter" data-level={level}>
    <span
      class="bar"
      role="img"
      aria-label={`Context window usage: ${usage.currentTokens} of ${usage.tokenLimit} tokens (${pct.toFixed(0)}%)`}
      title={`${usage.currentTokens.toLocaleString()} / ${usage.tokenLimit.toLocaleString()} tokens`}
    >
      <span class="fill" style="width: {pct}%"></span>
      <span class="label">
        ctx {fmt(usage.currentTokens)}/{fmt(usage.tokenLimit)} · {pct.toFixed(
          0,
        )}%
      </span>
    </span>
  </div>
{/if}

<style>
  .meter {
    display: inline-flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: var(--fs-xs);
    min-width: 180px;
  }
  .bar {
    position: relative;
    display: block;
    width: 100%;
    height: 18px;
    border-radius: 9px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    overflow: hidden;
    padding: 0;
    color: inherit;
    text-align: left;
  }
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--success);
    opacity: 0.55;
    transition: width 240ms ease-out;
  }
  .meter[data-level="mid"] .fill {
    background: var(--warning);
  }
  .meter[data-level="high"] .fill {
    background: var(--danger);
  }
  .label {
    position: relative;
    display: block;
    padding: 0 0.5rem;
    line-height: 18px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
</style>
