<script lang="ts">
  import {
    informationalActionLabel,
    informationalHeading,
    informationalResponse,
    type InformationalInteractiveRequest,
  } from "$lib/interactive/request-registry";
  import type { InteractiveResponse } from "$lib/types";

  let {
    request,
    busy,
    onRespond,
  }: {
    request: InformationalInteractiveRequest;
    busy: boolean;
    onRespond: (r: InteractiveResponse) => void;
  } = $props();
</script>

<div class="head">{informationalHeading(request)}</div>
<div class="body">
  <p>{request.summary}</p>
  {#if request.kind === "mcp_oauth" && request.authorizationUrl}
    <p>
      <a
        href={request.authorizationUrl}
        target="_blank"
        rel="noopener noreferrer">Open authorization URL</a
      >
    </p>
  {/if}
</div>
<div class="actions">
  <button
    class="btn"
    disabled={busy}
    onclick={() => onRespond(informationalResponse(request))}
    >{informationalActionLabel(request)}</button
  >
</div>
