<script lang="ts">
  import type { ToolCallRecord } from "$lib/types";
  import type {
    DisplayFileEdit,
    DisplayReasoningBlock,
  } from "$lib/client/display-message";
  import {
    parseProcArgs,
    parseProcExecutionArgs,
    parseProcExecutionMeta,
    parseProcExecutionResult,
    parseProcMeta,
    parseProcOutcome,
  } from "$lib/client/proc-display";
  import { selectSubagentChildren } from "$lib/client/subagent-display";
  import { formatFieldBytes } from "$lib/client/lazy-field";
  import {
    ensureLazyField,
    lazyFieldState,
  } from "$lib/client/lazy-field.svelte";
  import ToolCall from "./ToolCall.svelte";
  import DiffView from "./DiffView.svelte";
  import Pill from "./ui/Pill.svelte";

  let {
    toolCall,
    childTools = [],
    childEdits = [],
    allTools = [],
    allReasoning = [],
    allEdits = [],
    conversationId,
  }: {
    toolCall: ToolCallRecord;
    childTools?: ToolCallRecord[];
    childReasoning?: DisplayReasoningBlock[];
    childEdits?: DisplayFileEdit[];
    allTools?: ToolCallRecord[];
    allReasoning?: DisplayReasoningBlock[];
    allEdits?: DisplayFileEdit[];
    conversationId?: string | undefined;
  } = $props();

  let userToggled = $state(false);
  let manualOpen = $state(false);
  const pending = $derived(toolCall.status === "pending");
  const open = $derived(userToggled ? manualOpen : pending);
  const automaticallyOpen = $derived(pending && !userToggled);
  const resultTruncated = $derived(toolCall.resultTruncated === true);
  const lazyResult = $derived(
    lazyFieldState(conversationId, "tool-result", toolCall.id),
  );
  const resultJson = $derived(toolCall.resultJson ?? lazyResult.value);
  const args = $derived(
    parseProcArgs(toolCall.argsJson) ?? parseProcMeta(toolCall.meta),
  );
  const outcome = $derived(parseProcOutcome(resultJson));
  const executions = $derived(
    childTools.filter(
      (child) => child.tool === "execute" || child.tool === "finish",
    ),
  );
  const status = $derived(
    pending
      ? "running"
      : outcome?.status === "cannot_execute"
        ? "needs input"
        : toolCall.status === "ok"
          ? "completed"
          : "failed",
  );

  function onSummaryClick(event: MouseEvent) {
    event.preventDefault();
    const details = (event.currentTarget as HTMLElement)
      .parentElement as HTMLDetailsElement;
    const nextOpen = !details.open;
    userToggled = true;
    manualOpen = nextOpen;
    details.open = nextOpen;
  }

  function executionLabel(
    tool: string,
    saveAs: string | null | undefined,
  ): string {
    if (tool === "finish") return "final result";
    return saveAs ? `save: ${saveAs}` : "no save";
  }

  $effect(() => {
    if (open && resultTruncated) {
      ensureLazyField(conversationId, "tool-result", toolCall.id);
    }
  });
</script>

<details
  class="proc"
  data-status={toolCall.status}
  data-automatically-open={automaticallyOpen}
  {open}
>
  <summary onclick={onSummaryClick}>
    <span class="mark" aria-hidden="true">{executions.length || "·"}</span>
    <span class="title">{args?.summary ?? toolCall.summary ?? "Procedure"}</span
    >
    <Pill tone="accent">proc</Pill>
    <span class="status" class:running={pending}>{status}</span>
  </summary>

  <div class="content">
    {#if args}
      <div class="request-grid">
        <section>
          <div class="label">Procedure</div>
          <pre><code>{args.procedure}</code></pre>
        </section>
        <section>
          <div class="label">Result requirements</div>
          <p>{args.result_requirements}</p>
        </section>
      </div>
    {/if}

    {#if executions.length > 0}
      <section class="executions">
        <div class="section-heading">
          <span class="label">Executions</span>
          <span>{executions.length}</span>
        </div>
        <div class="stage-list">
          {#each executions as execution, index (execution.id)}
            {@const executionArgs =
              parseProcExecutionArgs(execution.argsJson) ??
              parseProcExecutionMeta(execution.meta)}
            {@const executionResult = parseProcExecutionResult(
              execution.resultJson,
            )}
            {@const nested = selectSubagentChildren(
              { tools: allTools, reasoning: allReasoning, edits: allEdits },
              execution.id,
            )}
            <details class="stage" open={execution.status === "error"}>
              <summary>
                <span class="step">{index + 1}</span>
                <span class="stage-title"
                  >{executionArgs?.needed_for ??
                    (execution.tool === "finish"
                      ? "Final result"
                      : "Execution")}</span
                >
                <Pill
                  >{executionLabel(
                    execution.tool,
                    executionArgs?.save_as,
                  )}</Pill
                >
                {#if executionResult?.value_bytes != null}
                  <span class="metric"
                    >{formatFieldBytes(executionResult.value_bytes)}</span
                  >
                {:else if executionResult?.bytes != null}
                  <span class="metric"
                    >{formatFieldBytes(executionResult.bytes)}</span
                  >
                {/if}
                {#if executionResult?.operations != null}
                  <span class="metric">{executionResult.operations} ops</span>
                {/if}
                <span class="stage-status" data-status={execution.status}
                ></span>
              </summary>
              <div class="stage-body">
                {#if executionResult?.error}
                  <p class="execution-error">{executionResult.error}</p>
                {/if}
                {#if executionArgs}
                  <details>
                    <summary class="minor-label">JavaScript</summary>
                    <pre><code>{executionArgs.javascript}</code></pre>
                  </details>
                {/if}
                {#if executionResult?.structure !== undefined}
                  <div class="projection">
                    <div class="minor-label">
                      Structure
                      {#if executionResult.structure_bytes != null}
                        · {formatFieldBytes(executionResult.structure_bytes)}
                      {/if}
                    </div>
                    <pre><code
                        >{typeof executionResult.structure === "string"
                          ? executionResult.structure
                          : JSON.stringify(
                              executionResult.structure,
                              null,
                              2,
                            )}</code
                      ></pre>
                  </div>
                {/if}
                {#if executionResult?.retry_safe === false}
                  <div class="effect-warning">
                    Partial effects may have occurred. This execution is not
                    safe to replay blindly.
                  </div>
                {/if}
                {#if nested.tools.length > 0 || nested.edits.length > 0}
                  <div class="trace">
                    <div class="minor-label">Capability trace</div>
                    {#each nested.tools as nestedTool (nestedTool.id)}
                      <ToolCall toolCall={nestedTool} {conversationId} />
                    {/each}
                    {#each nested.edits as edit (edit.id)}
                      <DiffView
                        path={edit.path}
                        diff={edit.diff}
                        collapsible
                        collapsedByDefault
                      />
                    {/each}
                  </div>
                {/if}
              </div>
            </details>
          {/each}
        </div>
      </section>
    {/if}

    {#if outcome}
      <section class="outcome">
        <div class="section-heading">
          <span class="label">Result</span>
          <span class="metrics">
            {#if outcome.bytes != null}{formatFieldBytes(outcome.bytes)}{/if}
            {#if outcome.usage?.turns != null}
              · {outcome.usage.turns} turns{/if}
            {#if outcome.usage?.operations != null}
              · {outcome.usage.operations} ops{/if}
          </span>
        </div>
        {#if outcome.error}
          <p class="error">{outcome.error}</p>
        {:else if outcome.projection !== undefined}
          <pre><code
              >{typeof outcome.projection === "string"
                ? outcome.projection
                : JSON.stringify(outcome.projection, null, 2)}</code
            ></pre>
        {/if}
      </section>
    {:else if resultTruncated}
      <section class="outcome">
        <div class="label">Result</div>
        <p class="status">
          {lazyResult.loading
            ? `Loading ${formatFieldBytes(toolCall.resultBytes)} result...`
            : (lazyResult.error ?? "Result is available on expansion.")}
        </p>
      </section>
    {/if}

    {#each childEdits as edit (edit.id)}
      <DiffView path={edit.path} diff={edit.diff} collapsible />
    {/each}
  </div>
</details>

<style>
  .proc {
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-md);
    background: var(--surface-2);
    font-size: var(--fs-md);
    overflow: clip;
  }
  .proc[data-status="error"] {
    border-left-color: var(--danger);
  }
  .proc > summary,
  .stage > summary {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    cursor: pointer;
    list-style: none;
  }
  .proc > summary {
    min-height: 2.5rem;
    padding: var(--space-2) var(--space-3);
  }
  summary::-webkit-details-marker {
    display: none;
  }
  .mark,
  .step {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    border-radius: 50%;
    background: var(--accent-bg);
    color: var(--accent);
    font-size: var(--fs-xs);
    font-weight: 700;
  }
  .mark {
    width: 1.5rem;
    height: 1.5rem;
  }
  .step {
    width: 1.25rem;
    height: 1.25rem;
  }
  .title,
  .stage-title {
    min-width: 0;
    font-weight: 600;
  }
  .title {
    flex: 1;
  }
  .stage-title {
    margin-right: auto;
  }
  .status,
  .metric,
  .metrics {
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  .status.running {
    color: var(--accent);
  }
  .content {
    border-top: 1px solid var(--border);
    padding: var(--space-3);
    display: grid;
    gap: var(--space-3);
  }
  .proc[data-automatically-open="true"] > .content {
    max-height: min(34rem, 60vh);
    overflow: auto;
  }
  .request-grid {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(14rem, 1fr);
    gap: var(--space-3);
  }
  section {
    min-width: 0;
  }
  .request-grid section,
  .outcome {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--space-3);
    background: var(--surface);
  }
  .label,
  .minor-label {
    color: var(--text-muted);
    font-size: var(--fs-xs);
    font-weight: 600;
    text-transform: uppercase;
  }
  p {
    margin: var(--space-2) 0;
  }
  pre {
    margin: var(--space-2) 0 0;
    padding: var(--space-2);
    overflow: auto;
    border: 1px solid var(--code-border);
    border-radius: var(--radius-sm);
    background: var(--code-bg);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .section-heading {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: var(--space-2);
  }
  .stage-list {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: clip;
  }
  .stage + .stage {
    border-top: 1px solid var(--border);
  }
  .stage > summary {
    min-height: 2.25rem;
    padding: var(--space-2);
    background: var(--surface);
  }
  .stage-status {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--text-muted);
  }
  .stage-status[data-status="ok"] {
    background: var(--success);
  }
  .stage-status[data-status="error"] {
    background: var(--danger);
  }
  .stage-body {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--surface-2);
  }
  .effect-warning {
    padding: var(--space-2);
    border-left: 3px solid var(--warning);
    background: var(--warning-bg);
  }
  .execution-error {
    margin: 0;
    padding: var(--space-2);
    border-left: 3px solid var(--danger);
    background: var(--danger-bg);
    color: var(--danger);
  }
  .trace {
    display: grid;
    gap: var(--space-2);
  }
  .error {
    color: var(--danger);
  }
  @media (max-width: 768px) {
    .request-grid {
      grid-template-columns: minmax(0, 1fr);
    }
    .metric {
      display: none;
    }
  }
</style>
