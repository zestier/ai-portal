<script lang="ts">
  import { untrack } from "svelte";
  import EmptyState from "./ui/EmptyState.svelte";
  import Alert from "./ui/Alert.svelte";
  import PanelHeader from "./ui/PanelHeader.svelte";

  let {
    conversationId,
    initialMemory = null,
  }: { conversationId: string; initialMemory?: unknown } = $props();

  let memory = $state<unknown>(untrack(() => initialMemory));
  let loading = $state(false);
  let wiping = $state(false);
  let busyItem = $state<string | null>(null);
  let error = $state<string | null>(null);

  const snapshot = $derived(
    (memory && typeof memory === "object" ? memory : {}) as Record<
      string,
      unknown
    >,
  );

  async function refresh() {
    loading = true;
    error = null;
    try {
      const res = await fetch(`/api/conversations/${conversationId}/memory`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { memory: unknown };
      memory = body.memory;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function wipe() {
    if (wiping) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "This permanently deletes all memory for this conversation. This action cannot be undone. Continue?",
      )
    ) {
      return;
    }
    wiping = true;
    error = null;
    try {
      const res = await fetch(`/api/conversations/${conversationId}/memory`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { memory: unknown };
      memory = body.memory;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      wiping = false;
    }
  }

  function items(key: string): unknown[] {
    const value = snapshot[key];
    return Array.isArray(value) ? value : [];
  }

  function factPredicate(row: unknown): string {
    return row && typeof row === "object"
      ? String((row as { predicate?: unknown }).predicate ?? "")
      : "";
  }

  // Directives (per-session standing rules) are facts with predicate
  // 'directive'. Surface them in their own section and exclude them from the
  // generic Facts list so each is shown once with directive-specific controls.
  const directiveRows = $derived(
    items("facts").filter(
      (row) => factPredicate(row).toLowerCase() === "directive",
    ),
  );
  const factRows = $derived(
    items("facts").filter(
      (row) => factPredicate(row).toLowerCase() !== "directive",
    ),
  );

  async function deactivateDirective(row: unknown) {
    const id = rowId(row);
    if (!id) return;
    // Retiring a directive tombstones the fact (status 'deleted'); after this
    // the packet builder no longer injects it. A bare 'superseded' status would
    // be re-promoted by fact consolidation, so deletion is the durable retire.
    await mutateItem("facts", id, "PATCH", { status: "deleted" });
  }

  function formatDirective(row: unknown): string {
    if (!row || typeof row !== "object") return "";
    const value = (row as { value?: unknown }).value;
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  async function editItem(kind: string, row: unknown) {
    const id = rowId(row);
    if (!id) return;
    const raw = prompt(
      "Edit memory item JSON",
      JSON.stringify(editablePayload(kind, row), null, 2),
    );
    if (raw == null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      error = `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      error = "Edited memory item must be a JSON object.";
      return;
    }
    await mutateItem(kind, id, "PATCH", parsed);
  }

  async function deleteItem(kind: string, row: unknown) {
    const id = rowId(row);
    if (!id) return;
    await mutateItem(kind, id, "DELETE");
  }

  async function reviewPatchItem(row: unknown, decision: "approve" | "reject") {
    const id = rowId(row);
    if (!id || busyItem) return;
    busyItem = `patch-item:${id}`;
    error = null;
    try {
      const res = await fetch(
        `/api/conversations/${conversationId}/memory/patch-items/${id}/review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { memory: unknown };
      memory = body.memory;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busyItem = null;
    }
  }

  async function mutateItem(
    kind: string,
    id: string,
    method: "PATCH" | "DELETE",
    body?: object,
  ) {
    if (busyItem) return;
    busyItem = `${kind}:${id}`;
    error = null;
    try {
      const res = await fetch(
        `/api/conversations/${conversationId}/memory/${kind}/${id}`,
        {
          method,
          ...(body ? { headers: { "content-type": "application/json" } } : {}),
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { memory: unknown };
      memory = data.memory;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busyItem = null;
    }
  }

  function rowId(row: unknown): string | null {
    return row &&
      typeof row === "object" &&
      typeof (row as { id?: unknown }).id === "string"
      ? (row as { id: string }).id
      : null;
  }

  function editablePayload(
    kind: string,
    row: unknown,
  ): Record<string, unknown> {
    if (!row || typeof row !== "object") return {};
    const record = row as Record<string, unknown>;
    if (kind === "entities") {
      return pick(record, [
        "entityType",
        "displayName",
        "summary",
        "status",
        "metadata",
      ]);
    }
    if (kind === "facts") {
      return pick(record, [
        "predicate",
        "value",
        "status",
        "visibility",
        "confidence",
      ]);
    }
    if (kind === "openLoops") {
      return pick(record, [
        "loopType",
        "title",
        "description",
        "status",
        "priority",
        "relatedEntityIds",
      ]);
    }
    if (kind === "globalMemories") {
      return pick(record, ["kind", "memoryKey", "value"]);
    }
    return record;
  }

  function pick(
    record: Record<string, unknown>,
    keys: string[],
  ): Record<string, unknown> {
    return Object.fromEntries(
      keys.filter((key) => key in record).map((key) => [key, record[key]]),
    );
  }
</script>

<section class="memory-inspector">
  <PanelHeader title="Session memory">
    {#snippet meta()}
      Inspect durable memory for this conversation. Memory is scoped to this
      session.
    {/snippet}
    {#snippet actions()}
      <button type="button" onclick={refresh} disabled={loading}
        >{loading ? "Refreshing…" : "Refresh"}</button
      >
      <button type="button" class="danger" onclick={wipe} disabled={wiping}>
        {wiping ? "Wiping…" : "Wipe memory"}
      </button>
    {/snippet}
  </PanelHeader>
  <div class="body">
    {#if error}
      <div class="error-wrap">
        <Alert kind="error">Memory inspector failed: {error}</Alert>
      </div>
    {/if}
    <div class="mode">
      Mode: <strong>{String(snapshot.mode ?? "off")}</strong>
    </div>
    <div class="grid">
      {@render DirectiveList(directiveRows)}
      {@render MemoryList("Entities", "entities", items("entities"), true)}
      {@render MemoryList("Facts", "facts", factRows, true)}
      {@render MemoryList("Open loops", "openLoops", items("openLoops"), true)}
      {@render MemoryList("Events", "events", items("events"), false)}
      {@render MemoryList("Patches", "patches", items("patches"), false)}
      {@render MemoryList(
        "Patch items",
        "patchItems",
        items("patchItems"),
        false,
      )}
      {@render MemoryList(
        "Global memories",
        "globalMemories",
        items("globalMemories"),
        true,
      )}
      {@render MemoryList(
        "Validation issues",
        "issues",
        items("issues"),
        false,
      )}
      {@render MemoryList("Tool calls", "toolCalls", items("toolCalls"), false)}
    </div>
  </div>
</section>

{#snippet DirectiveList(rows: unknown[])}
  <section class="panel directives">
    <h3>Directives <span>{rows.length}</span></h3>
    <p class="hint">
      Standing rules injected verbatim into every turn for this conversation.
    </p>
    {#if rows.length === 0}
      <EmptyState size="sm" description="No standing directives." />
    {:else}
      <div class="rows">
        {#each rows as row}
          <div class="memory-row">
            <div class="row-actions">
              <button
                type="button"
                disabled={busyItem !== null}
                onclick={() => editItem("facts", row)}>Edit</button
              >
              <button
                type="button"
                class="danger"
                disabled={busyItem !== null}
                onclick={() => deactivateDirective(row)}>Deactivate</button
              >
            </div>
            <div class="directive-text">{formatDirective(row)}</div>
          </div>
        {/each}
      </div>
    {/if}
  </section>
{/snippet}

{#snippet MemoryList(
  title: string,
  kind: string,
  rows: unknown[],
  editable: boolean,
)}
  <section class="panel">
    <h3>{title} <span>{rows.length}</span></h3>
    {#if rows.length === 0}
      <EmptyState size="sm" description="No records." />
    {:else}
      <div class="rows">
        {#each rows as row}
          <div class="memory-row">
            <div class="row-actions">
              {#if editable}
                <button
                  type="button"
                  disabled={busyItem !== null}
                  onclick={() => editItem(kind, row)}>Edit</button
                >
                <button
                  type="button"
                  class="danger"
                  disabled={busyItem !== null}
                  onclick={() => deleteItem(kind, row)}>Delete</button
                >
              {:else if kind === "patchItems"}
                {#if (row as { reviewStatus?: string }).reviewStatus !== "approved"}
                  <button
                    type="button"
                    disabled={busyItem !== null}
                    onclick={() => reviewPatchItem(row, "approve")}
                    >Approve</button
                  >
                {/if}
                {#if (row as { reviewStatus?: string }).reviewStatus !== "rejected"}
                  <button
                    type="button"
                    class="danger"
                    disabled={busyItem !== null}
                    onclick={() => reviewPatchItem(row, "reject")}
                    >Reject</button
                  >
                {/if}
              {/if}
            </div>
            <pre>{JSON.stringify(row, null, 2)}</pre>
          </div>
        {/each}
      </div>
    {/if}
  </section>
{/snippet}

<style>
  .memory-inspector {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .body {
    padding: var(--space-4) var(--space-5);
  }
  h3 {
    margin: 0;
  }
  button {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: inherit;
    border-radius: 4px;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
  }
  button.danger {
    border-color: color-mix(in srgb, var(--danger) 60%, var(--border));
    color: var(--danger);
  }
  button:disabled {
    opacity: 0.5;
    cursor: progress;
  }
  .mode {
    margin-bottom: var(--space-3);
    font-size: var(--fs-sm);
  }
  .error-wrap {
    margin-bottom: var(--space-3);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(22rem, 1fr));
    gap: var(--space-3);
  }
  .panel {
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    padding: var(--space-3);
  }
  .panel h3 {
    display: flex;
    justify-content: space-between;
    font-size: var(--fs-sm);
    margin-bottom: var(--space-2);
  }
  .panel h3 span {
    color: var(--text-muted);
    font-weight: 400;
  }
  .panel .hint {
    margin: 0 0 var(--space-2);
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }
  .directive-text {
    padding: var(--space-2);
    border-radius: 4px;
    background: var(--surface-2);
    font-size: var(--fs-sm);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .memory-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .row-actions {
    display: flex;
    gap: var(--space-1);
    justify-content: flex-end;
  }
  .row-actions button {
    padding: 0.15rem 0.45rem;
    font-size: var(--fs-xs);
  }
  pre {
    max-height: 18rem;
    overflow: auto;
    margin: 0;
    padding: var(--space-2);
    border-radius: 4px;
    background: var(--surface-2);
    font-family: var(--mono);
    font-size: var(--fs-xs);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
