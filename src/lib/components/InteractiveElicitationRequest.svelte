<script lang="ts">
  import type {
    ElicitationSchema,
    ElicitationSchemaField,
    InteractiveElicitationView,
    InteractiveResponse,
  } from "$lib/types";

  let {
    request,
    busy,
    onRespond,
  }: {
    request: InteractiveElicitationView & { requestId: string };
    busy: boolean;
    onRespond: (r: InteractiveResponse) => void;
  } = $props();

  type FieldValue = string | number | boolean | string[];
  let formValues = $state<Record<string, FieldValue>>({});

  function defaultFormValues(
    schema: ElicitationSchema | undefined,
  ): Record<string, FieldValue> {
    const defaults: Record<string, FieldValue> = {};
    if (!schema) return defaults;
    for (const [key, f] of Object.entries(schema.properties)) {
      if ("default" in f && f.default !== undefined) {
        defaults[key] = f.default as FieldValue;
      } else if (f.type === "boolean") {
        defaults[key] = false;
      } else if (f.type === "array") {
        defaults[key] = [];
      } else {
        defaults[key] = "";
      }
    }
    return defaults;
  }

  $effect(() => {
    void request.requestId;
    formValues = defaultFormValues(request.requestedSchema);
  });

  function fieldLabel(name: string, f: ElicitationSchemaField): string {
    return f.title ?? name;
  }
</script>

<div class="head">{request.elicitationSource ?? "Agent"} needs information</div>
<div class="body">
  <p>{request.message}</p>
  {#if request.mode === "url" && request.url}
    <p>
      <a href={request.url} target="_blank" rel="noopener noreferrer"
        >{request.url}</a
      >
    </p>
    <div class="actions">
      <button
        class="btn"
        disabled={busy}
        onclick={() => onRespond({ kind: "elicitation", action: "decline" })}
        >Decline</button
      >
      <button
        class="btn primary"
        disabled={busy}
        onclick={() => onRespond({ kind: "elicitation", action: "accept" })}
        >Done</button
      >
    </div>
  {:else if request.requestedSchema}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        onRespond({
          kind: "elicitation",
          action: "accept",
          content: { ...formValues },
        });
      }}
    >
      {#each Object.entries(request.requestedSchema.properties) as [name, field] (name)}
        <label class="field">
          <span class="label">{fieldLabel(name, field)}</span>
          {#if field.description}<small class="muted">{field.description}</small
            >{/if}
          {#if field.type === "boolean"}
            <input
              type="checkbox"
              checked={Boolean(formValues[name])}
              onchange={(e) =>
                (formValues[name] = (
                  e.currentTarget as HTMLInputElement
                ).checked)}
            />
          {:else if field.type === "string" && field.enum}
            <select
              value={String(formValues[name] ?? "")}
              onchange={(e) =>
                (formValues[name] = (
                  e.currentTarget as HTMLSelectElement
                ).value)}
            >
              {#each field.enum as opt, i (i)}
                <option value={opt}>{field.enumNames?.[i] ?? opt}</option>
              {/each}
            </select>
          {:else if field.type === "string"}
            <input
              type="text"
              value={String(formValues[name] ?? "")}
              oninput={(e) =>
                (formValues[name] = (
                  e.currentTarget as HTMLInputElement
                ).value)}
            />
          {:else if field.type === "number" || field.type === "integer"}
            <input
              type="number"
              value={Number(formValues[name] ?? 0)}
              oninput={(e) =>
                (formValues[name] = Number(
                  (e.currentTarget as HTMLInputElement).value,
                ))}
            />
          {:else}
            <input
              type="text"
              value={String(formValues[name] ?? "")}
              oninput={(e) =>
                (formValues[name] = (
                  e.currentTarget as HTMLInputElement
                ).value)}
            />
          {/if}
        </label>
      {/each}
      <div class="actions">
        <button
          type="button"
          class="btn"
          disabled={busy}
          onclick={() => onRespond({ kind: "elicitation", action: "cancel" })}
          >Cancel</button
        >
        <button
          type="button"
          class="btn"
          disabled={busy}
          onclick={() => onRespond({ kind: "elicitation", action: "decline" })}
          >Decline</button
        >
        <button type="submit" class="btn primary" disabled={busy}>Submit</button
        >
      </div>
    </form>
  {:else}
    <div class="actions">
      <button
        class="btn"
        disabled={busy}
        onclick={() => onRespond({ kind: "elicitation", action: "decline" })}
        >Decline</button
      >
      <button
        class="btn primary"
        disabled={busy}
        onclick={() => onRespond({ kind: "elicitation", action: "accept" })}
        >Accept</button
      >
    </div>
  {/if}
</div>
