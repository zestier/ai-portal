<script lang="ts">
  import type {
    InteractiveResponse,
    InteractiveUserInputView,
  } from "$lib/types";

  let {
    request,
    busy,
    onRespond,
  }: {
    request: InteractiveUserInputView & { requestId: string };
    busy: boolean;
    onRespond: (r: InteractiveResponse) => void;
  } = $props();

  let answer = $state("");

  $effect(() => {
    void request.requestId;
    answer = "";
  });
</script>

<div class="head">The agent has a question</div>
<div class="body">
  <p>{request.question}</p>
  {#if request.choices && request.choices.length > 0}
    <div class="choices">
      {#each request.choices as choice, i (`${choice}\0${i}`)}
        <button
          type="button"
          class="btn"
          disabled={busy}
          onclick={() =>
            onRespond({
              kind: "user_input",
              answer: choice,
              wasFreeform: false,
            })}>{choice}</button
        >
      {/each}
    </div>
  {/if}
  {#if request.allowFreeform}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        onRespond({ kind: "user_input", answer, wasFreeform: true });
      }}
    >
      <input
        type="text"
        bind:value={answer}
        placeholder="Your answer..."
        disabled={busy}
      />
      <button type="submit" class="btn primary" disabled={busy || !answer}
        >Send</button
      >
    </form>
  {/if}
</div>
