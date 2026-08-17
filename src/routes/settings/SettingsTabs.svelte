<script lang="ts">
  import { resolve } from "$app/paths";
  import type { SettingsTab } from "./settings-types";

  let {
    tabs,
    activeTab,
    grantCount,
  }: {
    tabs: SettingsTab[];
    activeTab: SettingsTab;
    grantCount: number;
  } = $props();

  function tabLabel(tab: SettingsTab): string {
    switch (tab) {
      case "general":
        return "General";
      case "prompts":
        return "Prompts";
      case "memory":
        return "Memory";
      case "permissions":
        return `Permissions (${grantCount})`;
      case "models":
        return "Models";
      case "extensions":
        return "Extensions";
      case "activity":
        return "Activity";
      case "update":
        return "Update";
    }
  }
</script>

<div
  class="settings-tabs scroll-mask"
  role="tablist"
  aria-label="Settings sections"
>
  {#each tabs as tab (tab)}
    <a
      id="settings-tab-{tab}"
      role="tab"
      aria-selected={activeTab === tab}
      aria-controls="settings-panel-{tab}"
      class:active={activeTab === tab}
      href={resolve(tab === "general" ? "/settings" : `/settings?tab=${tab}`)}
      data-sveltekit-reload
    >
      {tabLabel(tab)}
    </a>
  {/each}
</div>

<style>
  .settings-tabs {
    display: flex;
    gap: 0.35rem;
    margin-bottom: 1rem;
    overflow-x: auto;
    border-bottom: 1px solid var(--border);
  }
  .settings-tabs a {
    background: transparent;
    color: var(--text-muted);
    border: 0;
    border-bottom: 2px solid transparent;
    padding: 0.65rem 0.85rem;
    cursor: pointer;
    font: inherit;
    text-decoration: none;
    white-space: nowrap;
    scroll-snap-align: start;
  }
  .settings-tabs a:hover {
    color: var(--text);
  }
  .settings-tabs a.active {
    color: var(--text);
    border-bottom-color: var(--accent);
  }
</style>
