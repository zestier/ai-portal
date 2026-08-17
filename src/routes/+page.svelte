<script lang="ts">
  import EmptyState from "$lib/components/ui/EmptyState.svelte";
  import Alert from "$lib/components/ui/Alert.svelte";
  import PromptTemplateLauncher from "$lib/components/PromptTemplateLauncher.svelte";

  let error = $state<string | null>(null);
</script>

<div class="home">
  <EmptyState
    title="Zestier's AI Portal"
    description="Start a new conversation, or pick one from the sidebar."
    size="lg"
  >
    {#snippet actions()}
      <PromptTemplateLauncher
        variant="home"
        onError={(message) => (error = message)}
      />
    {/snippet}
  </EmptyState>
  {#if error}
    <div class="error-wrap">
      <Alert kind="error" dismissible ondismiss={() => (error = null)}
        >{error}</Alert
      >
    </div>
  {/if}
</div>

<style>
  .home {
    max-width: 540px;
    margin: 10vh auto;
    margin: 10dvh auto;
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .error-wrap {
    width: 100%;
  }
</style>
