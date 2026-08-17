<script lang="ts">
  import type { InteractiveRequestView, InteractiveResponse } from "$lib/types";
  import { focusTrap } from "$lib/actions/focus-trap";
  import { isInformationalInteractiveRequest } from "$lib/interactive/request-registry";
  import InteractiveAutoModeSwitchRequest from "./InteractiveAutoModeSwitchRequest.svelte";
  import InteractiveElicitationRequest from "./InteractiveElicitationRequest.svelte";
  import InteractiveGrantRequest from "./InteractiveGrantRequest.svelte";
  import InteractiveInformationalRequest from "./InteractiveInformationalRequest.svelte";
  import InteractivePermissionRequest from "./InteractivePermissionRequest.svelte";
  import InteractiveUserInputRequest from "./InteractiveUserInputRequest.svelte";
  import InteractiveWorkspaceFileRequest from "./InteractiveWorkspaceFileRequest.svelte";

  let {
    request,
    onRespond,
  }: {
    request: InteractiveRequestView;
    onRespond: (r: InteractiveResponse) => void;
  } = $props();

  let busy = $state(false);

  async function pick(r: InteractiveResponse) {
    if (busy) return;
    busy = true;
    try {
      await onRespond(r);
    } finally {
      busy = false;
    }
  }
</script>

{#if request.kind === "permission"}
  {#if request.grantRequest}
    <InteractiveGrantRequest {request} onRespond={pick} />
  {:else}
    <InteractivePermissionRequest {request} onRespond={pick} />
  {/if}
{:else}
  <div
    class="interactive"
    role="alertdialog"
    aria-modal="true"
    tabindex="-1"
    use:focusTrap
  >
    {#if request.kind === "auto_mode_switch"}
      <InteractiveAutoModeSwitchRequest {request} {busy} onRespond={pick} />
    {:else if request.kind === "user_input"}
      <InteractiveUserInputRequest {request} {busy} onRespond={pick} />
    {:else if request.kind === "elicitation"}
      <InteractiveElicitationRequest {request} {busy} onRespond={pick} />
    {:else if isInformationalInteractiveRequest(request)}
      <InteractiveInformationalRequest {request} {busy} onRespond={pick} />
    {:else if request.kind === "workspace_file"}
      <InteractiveWorkspaceFileRequest {request} {busy} onRespond={pick} />
    {/if}
  </div>
{/if}

<style>
  .interactive {
    border: 1px solid var(--warning);
    background: var(--warning-bg);
    border-radius: var(--radius-lg);
    padding: var(--space-3) var(--space-4);
  }
  :global(.interactive .head) {
    font-weight: 600;
    margin-bottom: 0.4rem;
  }
  :global(.interactive .body pre) {
    background: var(--surface);
    max-height: 200px;
    overflow: auto;
    margin-top: 0.4rem;
    font-size: var(--fs-md);
  }
  :global(.interactive .actions) {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.6rem;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  :global(.interactive .choices) {
    display: flex;
    gap: 0.4rem;
    margin: 0.4rem 0;
    flex-wrap: wrap;
  }
  :global(.interactive .field) {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    margin: 0.5rem 0;
  }
  :global(.interactive .field .label) {
    font-weight: 500;
    font-size: var(--fs-md);
  }
  :global(.interactive form input[type="text"]),
  :global(.interactive form input[type="number"]),
  :global(.interactive form select) {
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: inherit;
  }
</style>
