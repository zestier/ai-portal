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
  // Tri-state: "inherit" = omit from build (use provider/bundled default),
  // "false"/"true" = emit explicitly. loadState maps these from initial.
  type TriBool = "inherit" | "false" | "true";
  let allowFallbacks = $state<TriBool>("inherit");
  let zdr = $state<TriBool>("inherit");
  let requireParameters = $state<TriBool>("inherit");
  let enforceDistillable = $state<TriBool>("inherit");
  // data_collection: inherit | "allow" | "deny"
  let dataCollection = $state<string>("inherit");
  // sort.by: inherit | "" | price | latency | throughput
  let sortBy = $state<string>("inherit");
  let sortPartition = $state<string>("inherit");
  // Tags: boolean inherit vs explicit (array may be empty)
  let tagInherit = $state<Record<string, boolean>>({
    order: true,
    only: true,
    ignore: true,
    quantizations: true,
  });
  let tags = $state<Record<string, string[]>>({
    order: [],
    only: [],
    ignore: [],
    quantizations: [],
  });
  // Numerics: inherit | value string
  let maxPricePrompt = $state<string>("inherit");
  let maxPriceCompletion = $state<string>("inherit");
  let throughP50 = $state<string>("inherit");
  let throughP90 = $state<string>("inherit");
  let latencyP50 = $state<string>("inherit");
  let latencyP90 = $state<string>("inherit");
  let latencyP99 = $state<string>("inherit");

  function numStr(v: unknown): string {
    return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
  }

  function routing(): Record<string, unknown> | null {
    return initial && typeof initial === "object" ? initial : null;
  }

  function open() {
    const r = routing() ?? {};
    const has = (k: string): boolean => k in r;
    allowFallbacks = has("allow_fallbacks")
      ? r.allow_fallbacks === true
        ? "true"
        : "false"
      : "inherit";
    dataCollection = has("data_collection")
      ? (r.data_collection as string)
      : "inherit";
    zdr = has("zdr") ? (r.zdr === true ? "true" : "false") : "inherit";
    requireParameters = has("require_parameters")
      ? r.require_parameters === true
        ? "true"
        : "false"
      : "inherit";
    enforceDistillable = has("enforce_distillable_text")
      ? r.enforce_distillable_text === true
        ? "true"
        : "false"
      : "inherit";
    for (const f of TAG_FIELDS) {
      tagInherit[f.key] = !has(f.key);
      tags[f.key] = arr(r[f.key]);
    }
    const sort = (r.sort && typeof r.sort === "object" ? r.sort : {}) as Record<
      string,
      unknown
    >;
    sortBy = has("sort") && typeof sort.by === "string" ? sort.by : "inherit";
    sortPartition =
      has("sort") && typeof sort.partition === "string"
        ? sort.partition
        : "inherit";
    const mp = (
      r.max_price && typeof r.max_price === "object" ? r.max_price : {}
    ) as Record<string, unknown>;
    maxPricePrompt = has("max_price") ? numStr(mp.prompt) : "inherit";
    maxPriceCompletion = has("max_price") ? numStr(mp.completion) : "inherit";
    const th = (
      r.preferred_min_throughput &&
      typeof r.preferred_min_throughput === "object"
        ? r.preferred_min_throughput
        : {}
    ) as Record<string, unknown>;
    throughP50 = has("preferred_min_throughput") ? numStr(th.p50) : "inherit";
    throughP90 = has("preferred_min_throughput") ? numStr(th.p90) : "inherit";
    const lat = (
      r.preferred_max_latency && typeof r.preferred_max_latency === "object"
        ? r.preferred_max_latency
        : {}
    ) as Record<string, unknown>;
    latencyP50 = has("preferred_max_latency") ? numStr(lat.p50) : "inherit";
    latencyP90 = has("preferred_max_latency") ? numStr(lat.p90) : "inherit";
    latencyP99 = has("preferred_max_latency") ? numStr(lat.p99) : "inherit";
    editing = true;
  }
  function numDisplay(v: string): string {
    return v === "inherit" ? "" : v;
  }
  function numState(v: string): string {
    return v === "" ? "inherit" : v;
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
    if (allowFallbacks !== "inherit")
      o.allow_fallbacks = allowFallbacks === "true";
    if (dataCollection !== "inherit") o.data_collection = dataCollection;
    if (zdr !== "inherit") o.zdr = zdr === "true";
    if (requireParameters !== "inherit")
      o.require_parameters = requireParameters === "true";
    if (enforceDistillable !== "inherit")
      o.enforce_distillable_text = enforceDistillable === "true";
    for (const f of TAG_FIELDS) {
      if (!tagInherit[f.key] && tags[f.key].length) o[f.key] = [...tags[f.key]];
    }
    if (sortBy !== "inherit" || sortPartition !== "inherit") {
      const s: Record<string, string> = {};
      if (sortBy !== "inherit") s.by = sortBy;
      if (sortPartition !== "inherit") s.partition = sortPartition;
      o.sort = s;
    }
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
    if (r.data_collection === "allow") bits.push("data allow");
    else if (r.data_collection === "deny") bits.push("data deny");
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
          <div class="tag-header">
            <span>{f.label}</span>
            <label class="inherit-toggle">
              <input
                type="checkbox"
                checked={tagInherit[f.key]}
                onchange={() => {
                  tagInherit = { ...tagInherit, [f.key]: !tagInherit[f.key] };
                  if (tagInherit[f.key]) tags = { ...tags, [f.key]: [] };
                }}
              /> inherit
            </label>
          </div>
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div
            class="tag-input"
            class:dim={tagInherit[f.key]}
            onclick={() => {
              if (tagInherit[f.key]) {
                tagInherit = { ...tagInherit, [f.key]: false };
                setTimeout(
                  () =>
                    document.getElementById(`routing-${f.key}-input`)?.focus(),
                  0,
                );
              }
            }}
          >
            {#each tags[f.key] as t (t)}
              <span class="chip"
                >{t}<button
                  type="button"
                  class="chip-x"
                  onclick={(e) => {
                    e.stopPropagation();
                    removeTag(f.key, t);
                  }}
                  aria-label={`Remove ${t}`}>×</button
                ></span
              >
            {/each}
            <input
              id={`routing-${f.key}-input`}
              placeholder="add + Enter"
              disabled={tagInherit[f.key]}
              onkeydown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (!tagInherit[f.key]) addTag(f.key);
                }
              }}
            />
          </div>
        </label>
      {/each}

      <div class="grid2">
        <label class="inline-field">
          allow fallbacks
          <select bind:value={allowFallbacks}>
            <option value="inherit">inherit</option>
            <option value="false">off</option>
            <option value="true">on</option>
          </select>
        </label>
        <label class="inline-field">
          data collection
          <select bind:value={dataCollection}>
            <option value="inherit">inherit</option>
            <option value="allow">allow</option>
            <option value="deny">deny</option>
          </select>
        </label>
        <label class="inline-field">
          sort by
          <select bind:value={sortBy}>
            <option value="inherit">inherit</option>
            <option value="">—</option>
            <option value="price">price</option>
            <option value="latency">latency</option>
            <option value="throughput">throughput</option>
          </select>
        </label>
        <label class="inline-field">
          sort partition
          <input
            value={numDisplay(sortPartition)}
            oninput={(e) => (sortPartition = numState(e.currentTarget.value))}
            placeholder="model"
          />
        </label>
      </div>

      <details class="advanced">
        <summary>Advanced</summary>
        <div class="advanced-body">
          <div class="grid2">
            <label class="inline-field">
              zero data retention
              <select bind:value={zdr}>
                <option value="inherit">inherit</option>
                <option value="false">off</option>
                <option value="true">on</option>
              </select>
            </label>
            <label class="inline-field">
              require parameters
              <select bind:value={requireParameters}>
                <option value="inherit">inherit</option>
                <option value="false">off</option>
                <option value="true">on</option>
              </select>
            </label>
            <label class="inline-field">
              enforce distillable text
              <select bind:value={enforceDistillable}>
                <option value="inherit">inherit</option>
                <option value="false">off</option>
                <option value="true">on</option>
              </select>
            </label>
          </div>
          <div class="grid2 nums">
            <label
              >max price / prompt ($)<input
                type="number"
                value={numDisplay(maxPricePrompt)}
                oninput={(e) =>
                  (maxPricePrompt = numState(e.currentTarget.value))}
              /></label
            >
            <label
              >max price / completion ($)<input
                type="number"
                value={numDisplay(maxPriceCompletion)}
                oninput={(e) =>
                  (maxPriceCompletion = numState(e.currentTarget.value))}
              /></label
            >
            <label
              >min throughput p50<input
                type="number"
                value={numDisplay(throughP50)}
                oninput={(e) => (throughP50 = numState(e.currentTarget.value))}
              /></label
            >
            <label
              >min throughput p90<input
                type="number"
                value={numDisplay(throughP90)}
                oninput={(e) => (throughP90 = numState(e.currentTarget.value))}
              /></label
            >
            <label
              >max latency p50<input
                type="number"
                value={numDisplay(latencyP50)}
                oninput={(e) => (latencyP50 = numState(e.currentTarget.value))}
              /></label
            >
            <label
              >max latency p90<input
                type="number"
                value={numDisplay(latencyP90)}
                oninput={(e) => (latencyP90 = numState(e.currentTarget.value))}
              /></label
            >
            <label
              >max latency p99<input
                type="number"
                value={numDisplay(latencyP99)}
                oninput={(e) => (latencyP99 = numState(e.currentTarget.value))}
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
  .tag-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .inherit-toggle {
    font-size: var(--fs-sm);
    color: var(--muted, #888);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.2rem;
  }
  .dim {
    opacity: 0.5;
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
