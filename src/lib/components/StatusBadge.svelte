<script lang="ts">
  import {
    STATUS_LABEL,
    STATUS_COLOR,
    type ChangeStatus,
  } from "$lib/client/file-browser";

  let { status }: { status: ChangeStatus } = $props();
</script>

<span class="status-pill" style:color={STATUS_COLOR[status]}
  >{STATUS_LABEL[status]}</span
>

<style>
  .status-pill {
    font-family: var(--mono);
    font-weight: 600;
    font-size: var(--fs-xs);
    padding: 0 0.25rem;
    flex: 0 0 auto;
  }
</style>
