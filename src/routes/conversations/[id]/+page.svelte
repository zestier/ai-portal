<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/stores";
  import Chat from "$lib/components/Chat.svelte";
  import ChangesTabIndicator from "$lib/components/ChangesTabIndicator.svelte";
  import FileBrowser from "$lib/components/FileBrowser.svelte";
  import WorktreeSwitcher from "$lib/components/WorktreeSwitcher.svelte";
  import MemoryInspector from "$lib/components/MemoryInspector.svelte";
  import ActionsPanel from "$lib/components/ActionsPanel.svelte";
  import type { PageData } from "./$types";
  let { data }: { data: PageData } = $props();

  type Tab = "chat" | "memory" | "changes" | "files" | "commits" | "actions";
  const tabs: Tab[] = [
    "chat",
    "memory",
    "changes",
    "files",
    "commits",
    "actions",
  ];

  function readTab(value: string | null): Tab {
    return value && tabs.includes(value as Tab) ? (value as Tab) : "chat";
  }

  const tab = $derived(readTab($page.url.searchParams.get("tab")));

  // Selected worktree lease, kept in the URL so a reload or shared link lands
  // on the same tree the user was looking at.
  const worktree = $derived($page.url.searchParams.get("worktree"));

  // Bumped after a merge so the file/change panes re-read both trees.
  let browserRefresh = $state(0);

  async function selectWorktree(leaseId: string | null) {
    if (leaseId === worktree) return;
    await goto(
      resolve(
        `/conversations/${data.conversation.id}${tab === "chat" ? "" : `?tab=${tab}`}${leaseId ? `${tab === "chat" ? "?" : "&"}worktree=${encodeURIComponent(leaseId)}` : ""}`,
      ),
      {
        keepFocus: true,
        noScroll: true,
        replaceState: true,
      },
    );
  }

  async function selectTab(nextTab: Tab) {
    if (nextTab === tab) return;
    await goto(
      resolve(
        `/conversations/${data.conversation.id}${nextTab === "chat" ? "" : `?tab=${nextTab}`}${worktree ? `${nextTab === "chat" ? "?" : "&"}worktree=${encodeURIComponent(worktree)}` : ""}`,
      ),
      { keepFocus: true, noScroll: true, replaceState: true },
    );
  }
</script>

<svelte:head>
  <title>{data.conversation.title} — Zestier's AI Portal</title>
</svelte:head>

<div class="conversation">
  <div class="tabs scroll-mask" role="tablist">
    <a
      id="conversation-tab-chat"
      role="tab"
      aria-selected={tab === "chat"}
      aria-controls="conversation-panel-chat"
      class:active={tab === "chat"}
      href={resolve(
        `/conversations/${data.conversation.id}${worktree ? `?worktree=${encodeURIComponent(worktree)}` : ""}`,
      )}
      data-sveltekit-reload
    >
      Chat
    </a>
    <a
      id="conversation-tab-memory"
      role="tab"
      aria-selected={tab === "memory"}
      aria-controls="conversation-panel-memory"
      class:active={tab === "memory"}
      href={resolve(
        `/conversations/${data.conversation.id}?tab=memory${worktree ? `&worktree=${encodeURIComponent(worktree)}` : ""}`,
      )}
      data-sveltekit-reload
    >
      Memory
    </a>
    <a
      id="conversation-tab-changes"
      role="tab"
      aria-selected={tab === "changes"}
      aria-controls="conversation-panel-changes"
      class:active={tab === "changes"}
      href={resolve(
        `/conversations/${data.conversation.id}?tab=changes${worktree ? `&worktree=${encodeURIComponent(worktree)}` : ""}`,
      )}
      data-sveltekit-reload
    >
      <span class="tab-label">
        <span>Changes</span>
        <ChangesTabIndicator conversationId={data.conversation.id} />
      </span>
    </a>
    <a
      id="conversation-tab-files"
      role="tab"
      aria-selected={tab === "files"}
      aria-controls="conversation-panel-files"
      class:active={tab === "files"}
      href={resolve(
        `/conversations/${data.conversation.id}?tab=files${worktree ? `&worktree=${encodeURIComponent(worktree)}` : ""}`,
      )}
      data-sveltekit-reload
    >
      Files
    </a>
    <a
      id="conversation-tab-commits"
      role="tab"
      aria-selected={tab === "commits"}
      aria-controls="conversation-panel-commits"
      class:active={tab === "commits"}
      href={resolve(
        `/conversations/${data.conversation.id}?tab=commits${worktree ? `&worktree=${encodeURIComponent(worktree)}` : ""}`,
      )}
      data-sveltekit-reload
    >
      Commits
    </a>
    <a
      id="conversation-tab-actions"
      role="tab"
      aria-selected={tab === "actions"}
      aria-controls="conversation-panel-actions"
      class:active={tab === "actions"}
      href={resolve(
        `/conversations/${data.conversation.id}?tab=actions${worktree ? `&worktree=${encodeURIComponent(worktree)}` : ""}`,
      )}
      data-sveltekit-reload
    >
      Actions
    </a>
  </div>
  <div
    id="conversation-panel-chat"
    role="tabpanel"
    aria-labelledby="conversation-tab-chat"
    class="tab-body"
    class:hidden={tab !== "chat"}
  >
    <Chat
      conversation={data.conversation}
      effectiveModel={data.effectiveModel}
      modelOptions={data.modelOptions}
      chatPlaceholder={data.chatPlaceholder}
      initialTranscript={data.transcript}
      initialUsage={data.contextUsage}
      parent={data.parent}
      initialActiveTurnId={data.activeTurnId}
      initialPendingInteractive={data.pendingInteractive}
      initialComposer={data.initialComposer}
    />
  </div>
  {#if tab === "memory"}
    <div
      id="conversation-panel-memory"
      role="tabpanel"
      aria-labelledby="conversation-tab-memory"
      class="tab-body"
    >
      <MemoryInspector
        conversationId={data.conversation.id}
        initialMemory={data.memorySnapshot}
      />
    </div>
  {:else if tab === "actions"}
    <div
      id="conversation-panel-actions"
      role="tabpanel"
      aria-labelledby="conversation-tab-actions"
      class="tab-body scrollable"
    >
      <ActionsPanel conversationId={data.conversation.id} />
    </div>
  {:else if tab !== "chat"}
    <div
      id="conversation-panel-{tab}"
      role="tabpanel"
      aria-labelledby="conversation-tab-{tab}"
      class="tab-body"
    >
      <WorktreeSwitcher
        conversationId={data.conversation.id}
        selected={worktree}
        onselect={selectWorktree}
        onmerged={() => (browserRefresh += 1)}
      />
      <FileBrowser
        conversationId={data.conversation.id}
        pane={tab}
        {worktree}
        refreshToken={browserRefresh}
        onSendToChat={() => selectTab("chat")}
      />
    </div>
  {/if}
</div>

<style>
  .conversation {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
    background-color: var(--surface);
    flex: 0 0 auto;
    overflow-x: auto;
    --scroll-mask-cover: var(--surface);
  }
  /* On mobile the sidebar toggle is a fixed-position hamburger at top-left;
	   inset the tab strip so it doesn't sit underneath. `scroll-padding-left`
	   keeps the inset honored by scroll-snap: without it, the first tab's
	   `scroll-snap-align: start` snaps to the bare start edge, scrolling the
	   strip by exactly the padding and sliding "Chat" back under the hamburger. */
  @media (max-width: 768px) {
    .tabs {
      padding-left: var(--mobile-hamburger-inset);
      scroll-padding-left: var(--mobile-hamburger-inset);
    }
  }
  .tabs a {
    background: transparent;
    color: var(--text-muted);
    border: 0;
    border-bottom: 2px solid transparent;
    padding: var(--space-2) var(--space-4);
    cursor: pointer;
    font: inherit;
    text-decoration: none;
    white-space: nowrap;
    scroll-snap-align: start;
  }
  .tab-label {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .tabs a.active {
    color: var(--text);
    border-bottom-color: var(--accent);
  }
  .tab-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .tab-body.hidden {
    display: none;
  }
  .tab-body.scrollable {
    overflow-y: auto;
  }
</style>
