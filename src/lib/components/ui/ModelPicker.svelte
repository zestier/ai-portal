<script lang="ts">
  let {
    value,
    options = [],
    label,
    name,
    emptyLabel,
    disabled = false,
    onchange,
  }: {
    /** Current selection. */
    value: string;
    /** Catalog of selectable model ids. */
    options?: string[];
    /** Optional visible label rendered next to the select. */
    label?: string;
    /** Native form field name. */
    name?: string;
    /** Text for the `''` option (a server default), shown first. */
    emptyLabel?: string;
    disabled?: boolean;
    onchange?: (v: string) => void;
  } = $props();

  // Keep a stale/unlisted override selectable instead of silently dropping it.
  const effectiveOptions = $derived(
    value && !options.includes(value) ? [value, ...options] : options,
  );
</script>

<div class="model-picker">
  {#if label}
    <span class="model-label">{label}</span>
  {/if}
  <select
    class="model-select"
    {name}
    {value}
    {disabled}
    onchange={(e) => onchange?.(e.currentTarget.value)}
  >
    {#if emptyLabel}
      <option value="">{emptyLabel}</option>
    {/if}
    {#each effectiveOptions as opt (opt)}
      <option value={opt}>{opt}</option>
    {/each}
  </select>
</div>

<style>
  .model-picker {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    min-width: 0;
  }
  .model-label {
    opacity: 0.6;
    min-width: 3.5rem;
  }
  .model-select {
    min-width: min(26rem, 100%);
    max-width: 100%;
    background: var(--surface-2);
    border: 1px solid var(--border-strong, var(--border));
    border-radius: 6px;
    color: inherit;
    font: inherit;
    font-size: var(--fs-xs);
    padding: 4px 10px;
    appearance: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    cursor: pointer;
    padding-right: 28px;
    background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none' stroke='%23808a99' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    background-size: 14px;
  }
  .model-select:hover:not(:disabled) {
    border-color: var(--accent);
  }
  .model-select:disabled {
    opacity: 0.5;
    cursor: progress;
  }
</style>
