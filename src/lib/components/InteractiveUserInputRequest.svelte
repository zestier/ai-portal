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

  // Per-item selected/typed answer and whether it came from free-form typing.
  // Index mirrors `request.questions`. `wasFreeform` is true if ANY item was
  // freeform (single bool for the whole call).
  let answers = $state<string[]>([]);
  let freeform = $state<boolean[]>([]);

  $effect(() => {
    void request.requestId;
    answers = request.questions.map(() => "");
    freeform = request.questions.map(() => false);
  });

  function submit() {
    onRespond({
      kind: "user_input",
      answers: request.questions.map((_, i) => answers[i]),
      wasFreeform: freeform.some(Boolean),
    });
  }
</script>

<div class="head">The agent has a question</div>
<div class="body">
  {#each request.questions as item, i (i)}
    <div class="item">
      <p>{item.question}</p>
      {#if item.choices && item.choices.length > 0}
        <div class="choices">
          {#each item.choices as choice (choice)}
            <button
              type="button"
              class="btn"
              disabled={busy}
              onclick={() => {
                answers[i] = choice;
                freeform[i] = false;
              }}>{choice}</button
            >
          {/each}
        </div>
      {/if}
      {#if request.allowFreeform}
        <input
          type="text"
          bind:value={answers[i]}
          oninput={() => {
            freeform[i] = true;
          }}
          placeholder="Your answer..."
          disabled={busy}
        />
      {/if}
    </div>
  {/each}
  <button type="button" class="btn primary" disabled={busy} onclick={submit}
    >Send</button
  >
</div>

<style>
  .item {
    margin-bottom: 0.8rem;
  }
  input {
    margin-top: 0.4rem;
    width: 100%;
  }
</style>
