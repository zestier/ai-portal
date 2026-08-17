<script lang="ts">
  import type {
    InteractiveAutoModeSwitchView,
    InteractiveResponse,
  } from "$lib/types";

  let {
    request,
    busy,
    onRespond,
  }: {
    request: InteractiveAutoModeSwitchView & { requestId: string };
    busy: boolean;
    onRespond: (r: InteractiveResponse) => void;
  } = $props();
</script>

<div class="head">Switch to auto mode?</div>
<div class="body">
  <p>
    The model provider hit a rate limit
    {#if request.errorCode}<span class="muted">({request.errorCode})</span>{/if}
    and is offering to switch models so this turn can continue.
    {#if request.retryAfterSeconds}
      <br />Otherwise wait ~{request.retryAfterSeconds}s for the limit to reset.
    {/if}
  </p>
</div>
<div class="actions">
  <button
    class="btn"
    disabled={busy}
    onclick={() => onRespond({ kind: "auto_mode_switch", decision: "no" })}
    >No</button
  >
  <button
    class="btn primary"
    disabled={busy}
    onclick={() => onRespond({ kind: "auto_mode_switch", decision: "yes" })}
    >Yes, once</button
  >
</div>
