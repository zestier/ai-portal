<script lang="ts">
  // Typed editor for pi's `compat.openRouterRouting` (OpenRouter provider
  // routing: see https://openrouter.ai/docs/guides/routing/provider-selection).
  // Pass the routing object itself (or null); on save it emits the built object
  // (or null when every field is empty). Parent owns persisting it via the
  // provider/model PATCH.

  let {
    initial,
    hint,
    onSave,
  }: {
    initial: Record<string, unknown> | null;
    hint?: string;
    onSave: (routing: Record<string, unknown> | null) => void;
  } = $props();

  const TAG_FIELDS = [
    { key: "order", label: "Priority order (provider ids, best first)" },
    { key: "only", label: "Restrict to providers (only)" },
    { key: "ignore", label: "Exclude providers (ignore)" },
    { key: "quantizations", label: "Quantizations" },
  ] as const;

  let editing = $state(false);
  let allowFallbacks = $state(false);
  let dataCollection = $state<"allow" | "deny">("allow");
  let tags = $state<Record<string, string[]>>({
    order: [],
    only: [],
    ignore: [],
    quantizations: [],
  });
  let sortBy = $state("");
  let sortPartition = $state("");
  let zdr = $state(false);
  let requireParameters = $state(false);
  let enforceDistillable = $state(false);
  let maxPricePrompt = $state("");
  let maxPriceCompletion = $state("");
  let throughP50 = $state("");
  let throughP90 = $state("");
  let latencyP50 = $state("");
  let latencyP90 = $state("");
  let latencyP99 = $state("");

  function numStr(v: unknown): string {
    return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
  }

  function routing(): Record<string, unknown> | null {
    return initial && typeof initial === "object" ? initial : null;
  }

  function open() {
    const r = routing() ?? {};
    allowFallbacks = r.allow_fallbacks === true;
    dataCollection = r.data_collection === "deny" ? "deny" : "allow";
    tags = {
      order: arr(r.order),
      only: arr(r.only),
      ignore: arr(r.ignore),
      quantizations: arr(r.quantizations),
    };
    const sort = (r.sort && typeof r.sort === "object" ? r.sort : {}) as Record<
      string,
      unknown
    >;
    sortBy = typeof sort.by === "string" ? sort.by : "";
    sortPartition = typeof sort.partition === "string" ? sort.partition : "";
    zdr = r.zdr === true;
    requireParameters = r.require_parameters === true;
    enforceDistillable = r.enforce_distillable_text === true;
    const mp = (
      r.max_price && typeof r.max_price === "object" ? r.max_price : {}
    ) as Record<string, unknown>;
    maxPricePrompt = numStr(mp.prompt);
    maxPriceCompletion = numStr(mp.completion);
    const th = (
      r.preferred_min_throughput &&
      typeof r.preferred_min_throughput === "object"
        ? r.preferred_min_throughput
        : {}
    ) as Record<string, unknown>;
    throughP50 = numStr(th.p50);
    throughP90 = numStr(th.p90);
    const lat = (
      r.preferred_max_latency && typeof r.preferred_max_latency === "object"
        ? r.preferred_max_latency
        : {}
    ) as Record<string, unknown>;
    latencyP50 = numStr(lat.p50);
    latencyP90 = numStr(lat.p90);
    latencyP99 = numStr(lat.p99);
    editing = true;
  }

  function arr(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is string => typeof x === "string" && x.trim() !== "",
    );
  }

  function addTag(field: string) {
    const input = document.getElementById(
      `routing-${field}-input`,
    ) as HTMLInputElement | null;
    const v = input?.value.trim();
    if (!v || tags[field].includes(v)) return;
    tags = { ...tags, [field]: [...tags[field], v] };
    if (input) input.value = "";
  }

  function removeTag(field: string, value: string) {
    tags = { ...tags, [field]: tags[field].filter((t) => t !== value) };
  }

  function number(s: string): number | undefined {
    const n = Number(s);
    return s.trim() !== "" && Number.isFinite(n) ? n : undefined;
  }

  function build(): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    if (allowFallbacks) o.allow_fallbacks = true;
    if (dataCollection === "deny") o.data_collection = "deny";
    for (const f of TAG_FIELDS) {
      if (tags[f.key].length) o[f.key] = [...tags[f.key]];
    }
    if (sortBy || sortPartition) {
      const s: Record<string, string> = {};
      if (sortBy) s.by = sortBy;
      if (sortPartition) s.partition = sortPartition;
      o.sort = s;
    }
    if (zdr) o.zdr = true;
    if (requireParameters) o.require_parameters = true;
    if (enforceDistillable) o.enforce_distillable_text = true;
    const mp: Record<string, number> = {};
    const prompt = number(maxPricePrompt);
    const completion = number(maxPriceCompletion);
    if (prompt !== undefined) mp.prompt = prompt;
    if (completion !== undefined) mp.completion = completion;
    if (Object.keys(mp).length) o.max_price = mp;
    const th: Record<string, number> = {};
    const t50 = number(throughP50);
    const t90 = number(throughP90);
    if (t50 !== undefined) th.p50 = t50;
    if (t90 !== undefined) th.p90 = t90;
    if (Object.keys(th).length) o.preferred_min_throughput = th;
    const lat: Record<string, number> = {};
    const l50 = number(latencyP50);
    const l90 = number(latencyP90);
    const l99 = number(latencyP99);
    if (l50 !== undefined) lat.p50 = l50;
    if (l90 !== undefined) lat.p90 = l90;
    if (l99 !== undefined) lat.p99 = l99;
    if (Object.keys(lat).length) o.preferred_max_latency = lat;
    return o;
  }

  function summary(): string {
    const r = routing();
    if (!r) return "not configured";
    const bits: string[] = [];
    const order = arr(r.order);
    const only = arr(r.only);
    const ignore = arr(r.ignore);
    if (order.length) bits.push(`${order.length} ordered`);
    if (only.length) bits.push(`only ${only.length}`);
    if (ignore.length) bits.push(`ignore ${ignore.length}`);
    if (r.allow_fallbacks) bits.push("fallbacks on");
    if (r.data_collection) bits.push(`data ${r.data_collection}`);
    if (r.sort) bits.push("custom sort");
    return bits.length ? bits.join(", ") : "configured";
  }

  function save() {
    const b = build();
    editing = false;
    onSave(Object.keys(b).length ? b : null);
  }

  function cancel() {
    editing = false;
  }
</script>

<div class="routing-editor">
  <div class="routing-head">
    <span class="muted small">Routing: {summary()}</span>
    {#if !editing}
      <button type="button" class="small" onclick={open}>Edit</button>
    {/if}
  </div>
  {#if hint}
    <p class="muted small routing-hint">{hint}</p>
  {/if}

  {#if editing}
    <div class="routing-form">
      {#each TAG_FIELDS as f (f.key)}
        <label>
          {f.label}
          <div class="tag-input">
            {#each tags[f.key] as t (t)}
              <span class="chip"
                >{t}<button
                  type="button"
                  class="chip-x"
                  onclick={() => removeTag(f.key, t)}
                  aria-label={`Remove ${t}`}>×</button
                ></span
              >
            {/each}
            <input
              id={`routing-${f.key}-input`}
              placeholder="add + Enter"
              onkeydown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTag(f.key);
                }
              }}
            />
          </div>
        </label>
      {/each}

      <div class="grid2">
        <label
          ><input type="checkbox" bind:checked={allowFallbacks} /> allow fallbacks</label
        >
        <label class="inline-field">
          data collection
          <select
            bind:value={dataCollection}
            onchange={(e) =>
              (dataCollection = e.currentTarget.value as "allow" | "deny")}
          >
            <option value="allow">allow</option>
            <option value="deny">deny</option>
          </select>
        </label>
        <label class="inline-field">
          sort by
          <select
            value={sortBy}
            onchange={(e) => (sortBy = e.currentTarget.value)}
          >
            <option value="">—</option>
            <option value="price">price</option>
            <option value="latency">latency</option>
            <option value="throughput">throughput</option>
          </select>
        </label>
        <label class="inline-field">
          sort partition
          <input bind:value={sortPartition} placeholder="model" />
        </label>
      </div>

      <details class="advanced">
        <summary>Advanced</summary>
        <div class="advanced-body">
          <div class="grid2">
            <label
              ><input type="checkbox" bind:checked={zdr} /> zero data retention</label
            >
            <label
              ><input type="checkbox" bind:checked={requireParameters} /> require
              parameters</label
            >
            <label
              ><input type="checkbox" bind:checked={enforceDistillable} /> enforce
              distillable text</label
            >
          </div>
          <div class="grid2 nums">
            <label
              >max price / prompt ($)<input
                type="number"
                bind:value={maxPricePrompt}
              /></label
            >
            <label
              >max price / completion ($)<input
                type="number"
                bind:value={maxPriceCompletion}
              /></label
            >
            <label
              >min throughput p50<input
                type="number"
                bind:value={throughP50}
              /></label
            >
            <label
              >min throughput p90<input
                type="number"
                bind:value={throughP90}
              /></label
            >
            <label
              >max latency p50<input
                type="number"
                bind:value={latencyP50}
              /></label
            >
            <label
              >max latency p90<input
                type="number"
                bind:value={latencyP90}
              /></label
            >
            <label
              >max latency p99<input
                type="number"
                bind:value={latencyP99}
              /></label
            >
          </div>
        </div>
      </details>

      <div class="form-actions">
        <button type="button" onclick={save}>Save</button>
        <button type="button" onclick={cancel}>Cancel</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .routing-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .routing-hint {
    margin: 0.25rem 0 0;
  }
  .routing-form {
    margin-top: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .tag-input {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
    border: 1px solid var(--border, #333);
    border-radius: 4px;
    padding: 0.25rem;
  }
  .tag-input input {
    border: none;
    outline: none;
    background: transparent;
    color: inherit;
    min-width: 8rem;
    flex: 1;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    background: var(--chip-bg, #222);
    border-radius: 10px;
    padding: 0.1rem 0.5rem;
    font-size: var(--fs-md);
  }
  .chip-x {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }
  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }
  .inline-field {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .advanced {
    border: 1px solid var(--border, #333);
    border-radius: 4px;
    padding: 0.25rem 0.5rem;
  }
  .advanced-body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem 0;
  }
  .nums label {
    display: flex;
    flex-direction: column;
    font-size: var(--fs-xs);
  }
  .form-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
</style>
