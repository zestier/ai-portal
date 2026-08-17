<script module lang="ts">
  // zod v4 JIT-compiles schemas via the Function constructor, which this
  // app's CSP policy (no 'unsafe-eval') blocks at runtime. The availability
  // probe is caught and harmless, but it fires a console.error that the
  // settings e2e treats as a page error. `jitless` skips the probe entirely.
  import { config } from "zod";
  config({ jitless: true });
</script>

<script lang="ts">
  import "../app.css";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import SidebarRail from "$lib/components/SidebarRail.svelte";
  import ImageLightbox from "$lib/components/ImageLightbox.svelte";
  import { invalidateAll } from "$app/navigation";
  import { onMount } from "svelte";
  import { setAwaitingInput } from "$lib/client/awaiting-input";
  import {
    clearConversationActivityOverrides,
    setConversationActivity,
  } from "$lib/client/conversation-activity";
  import { createTrailingDebounce } from "$lib/client/ticket-refresh";
  import { reconnectDelayMs } from "$lib/client/sse";
  import type { AppEvent } from "$lib/types";
  import {
    resolveInitialSidebarOpen,
    SIDEBAR_DESKTOP_MIN_WIDTH,
    SIDEBAR_MOBILE_MAX_WIDTH,
    SIDEBAR_STORAGE_KEY,
  } from "$lib/client/sidebar";

  let { data, children } = $props();

  // Default to open for SSR; the real value is resolved on mount where
  // localStorage and matchMedia are available.
  let sidebarOpen = $state(true);
  let hydrated = $state(false);

  function closeOnMobileNavigate() {
    if (
      window.matchMedia(`(max-width: ${SIDEBAR_MOBILE_MAX_WIDTH}px)`).matches
    ) {
      sidebarOpen = false;
    }
  }

  onMount(() => {
    sidebarOpen = resolveInitialSidebarOpen({
      getStored: () => localStorage.getItem(SIDEBAR_STORAGE_KEY),
      isDesktop: () =>
        window.matchMedia(`(min-width: ${SIDEBAR_DESKTOP_MIN_WIDTH}px)`)
          .matches,
    });
    hydrated = true;
  });

  $effect(() => {
    if (hydrated) {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarOpen));
    }
  });

  // Drive the app-shell height from the VisualViewport so the layout shrinks
  // to the *visible* region when the mobile soft keyboard opens. iOS Safari
  // ignores `interactive-widget` and does not shrink the layout viewport (or
  // `dvh`) for the keyboard — it overlays the keyboard and scrolls the page —
  // so the bottom of the chat (messages + composer) ends up hidden behind it.
  // Sizing to `visualViewport.height` keeps the composer just above the
  // keyboard and shrinks the messages container, which lets Chat.svelte's
  // ResizeObserver re-pin to the latest message. Falls back to `100dvh` (the
  // CSS default) where VisualViewport is unavailable.
  onMount(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      root.style.setProperty("--app-height", `${vv.height}px`);
    };
    update();
    vv.addEventListener("resize", update);
    return () => {
      vv.removeEventListener("resize", update);
      root.style.removeProperty("--app-height");
    };
  });

  // Single per-user global event feed for the whole app shell. Unlike the
  // per-turn stream (which only covers the open conversation), this keeps the
  // sidebar "awaiting input" indicator live for *every* conversation — a
  // background session that starts/stops awaiting input updates in place
  // without waiting for the next navigation/load. Layered over the server
  // `load` set + the open conversation's own turn-stream signal: an override
  // here simply takes precedence (see `isAwaitingInput`).
  onMount(() => {
    if (!data.user) return;
    // Coalesce bursts of ticket mutations (an agent can emit several per turn)
    // into a single sidebar refresh on the trailing edge.
    const refreshTickets = createTrailingDebounce(() => void invalidateAll());

    // Client-managed reconnect (instead of the browser's built-in
    // auto-reconnect) so we can add jitter on top of the server's `retry:`
    // directive — after a server restart, jittered reconnects de-correlate
    // the herd instead of every client retrying in lockstep. A fresh
    // EventSource can't resend the `Last-Event-ID` header, so we carry the
    // last id forward as a query param; the bus replays from that offset.
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let lastEventId = "";
    let stopped = false;
    let reconnected = false;

    const connect = () => {
      if (stopped) return;
      const url = lastEventId
        ? `/api/events?last-event-id=${encodeURIComponent(lastEventId)}`
        : "/api/events";
      source = new EventSource(url);
      source.onopen = () => {
        // A gap longer than the bus's replay buffer / channel TTL can leave
        // the sidebar's activity overrides pinned to stale values (they beat
        // the server `load` set by design). Re-sync from the server once the
        // feed is healthy again: drop the overrides, then re-run `load`.
        if (!reconnected) return;
        reconnected = false;
        clearConversationActivityOverrides();
        void invalidateAll();
      };
      source.onmessage = (e) => {
        if (e.lastEventId) lastEventId = e.lastEventId;
        let ev: AppEvent;
        try {
          ev = JSON.parse(e.data) as AppEvent;
        } catch {
          return;
        }
        if (!ev) return;
        if (ev.type === "awaiting.changed") {
          setAwaitingInput(ev.conversationId, ev.awaiting);
        } else if (ev.type === "activity.changed") {
          setConversationActivity(ev.conversationId, {
            running: ev.running,
            unread: ev.unread,
          });
        } else if (ev.type === "tickets.changed") {
          // Re-run the layout `load` so the sidebar ticket list/count reflects
          // the change — regardless of which page or conversation is focused.
          refreshTickets.trigger();
        }
      };
      // Named application-level error frame (see `sseResponse`). Distinct
      // from `onerror`, which is for transport failures — this fires when the
      // server emits an error frame over an otherwise healthy connection.
      source.addEventListener("stream_error", (e) => {
        console.warn("app events: stream_error", (e as MessageEvent).data);
      });
      source.onerror = () => {
        // Take over reconnection from the browser: close now (→ CLOSED, so
        // the native retry loop stops) and reopen after a jittered delay.
        if (stopped) return;
        source?.close();
        source = null;
        reconnected = true;
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, reconnectDelayMs());
      };
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      refreshTickets.cancel();
      source?.close();
    };
  });
</script>

{#if !data.user}
  {@render children()}
{:else}
  <div class="layout" class:collapsed={!sidebarOpen} class:preload={!hydrated}>
    <div class="rail-wrap">
      <SidebarRail
        user={data.user}
        expanded={sidebarOpen}
        ontoggle={() => (sidebarOpen = !sidebarOpen)}
        onnavigate={closeOnMobileNavigate}
      />
    </div>
    <button
      type="button"
      class="mobile-menu btn icon ghost"
      class:hidden={sidebarOpen}
      aria-label="Open menu"
      title="Open menu"
      onclick={() => (sidebarOpen = true)}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M2 4h12" />
        <path d="M2 8h12" />
        <path d="M2 12h12" />
      </svg>
    </button>
    {#if sidebarOpen}
      <button
        type="button"
        class="scrim"
        aria-label="Close sidebar"
        onclick={() => (sidebarOpen = false)}
      ></button>
    {/if}
    <aside class="sidebar" class:open={sidebarOpen} aria-hidden={!sidebarOpen}>
      <div class="drawer-header">
        <span class="drawer-brand">Zestier's AI Portal</span>
        <button
          type="button"
          class="drawer-close btn icon ghost"
          aria-label="Close menu"
          title="Close menu"
          onclick={() => (sidebarOpen = false)}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M4 4l8 8" />
            <path d="M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <Sidebar
        conversations={data.conversations}
        awaitingConversationIds={data.awaitingConversationIds}
        runningConversationIds={data.runningConversationIds}
        unreadConversationIds={data.unreadConversationIds}
        tickets={data.tickets}
        ticketCount={data.ticketCount}
        ticketWorkspace={data.ticketWorkspace}
        ticketActions={data.ticketActions}
        user={data.user}
        onnavigate={closeOnMobileNavigate}
      />
    </aside>
    <main class="main">
      {@render children()}
    </main>
  </div>
{/if}

<ImageLightbox />

<style>
  .layout {
    display: grid;
    grid-template-columns: 44px 280px 1fr;
    height: 100vh;
    height: 100dvh;
    /* JS sets --app-height from VisualViewport so the shell shrinks to the
		   visible area when the mobile keyboard opens (iOS Safari doesn't do
		   this for us). Falls back to 100dvh before hydration / where the
		   VisualViewport API is unavailable. */
    height: var(--app-height, 100dvh);
    /* viewport-fit=cover lets the shell paint edge-to-edge; carve the
		   in-flow content (ChatHeader at the top, Composer at the bottom,
		   the desktop sidebar) back out of the device safe areas. Resolves
		   to 0 on desktop and anywhere without insets. The mobile drawer and
		   hamburger are position:fixed overlays and inset themselves. */
    padding: env(safe-area-inset-top) env(safe-area-inset-right)
      env(safe-area-inset-bottom) env(safe-area-inset-left);
    overflow: hidden;
    transition: grid-template-columns 150ms ease-out;
  }
  .layout.collapsed {
    grid-template-columns: 44px 0 1fr;
  }
  .rail-wrap {
    display: contents;
  }
  .sidebar {
    background: var(--surface);
    border-right: 1px solid var(--border);
    /* The drawer is a flex column: an optional .drawer-header (mobile)
		   plus the Sidebar's .sidebar-inner, which flexes to fill the rest.
		   The inner list scrolls; the panel itself never does, so the pinned
		   footer (⚙ Settings) can't be pushed out of view. */
    display: flex;
    flex-direction: column;
    overflow: hidden;
    overflow-x: hidden;
    min-width: 0;
    min-height: 0;
  }
  .main {
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .scrim {
    display: none;
  }
  .drawer-header {
    display: none;
  }
  .mobile-menu {
    display: none;
  }
  .layout.preload,
  .layout.preload .sidebar {
    transition: none;
  }
  /* Pre-hydration: resolve the collapsed visuals from the inline script so
	   the first paint matches the persisted preference without a flash. */
  :global(html[data-sidebar="closed"]) .layout.preload {
    grid-template-columns: 44px 0 1fr;
  }

  @media (max-width: 768px) {
    .layout,
    .layout.collapsed {
      grid-template-columns: 1fr;
    }
    .rail-wrap {
      display: none;
    }
    .mobile-menu {
      display: inline-flex;
      position: fixed;
      top: calc(var(--space-2) + env(safe-area-inset-top));
      left: calc(var(--space-2) + env(safe-area-inset-left));
      z-index: var(--z-overlay);
    }
    .mobile-menu.hidden {
      display: none;
    }
    .sidebar {
      position: fixed;
      top: 0;
      left: 0;
      /* Fill the full visible height edge-to-edge (no dead gap below the
			   drawer). The drawer's own children inset themselves from the
			   safe areas: .drawer-header clears the top status bar / notch and
			   .bottom (the ⚙ Settings link) clears the home indicator / OS nav
			   bar. viewport-fit=cover makes those env() insets resolve > 0. */
      height: 100vh;
      height: 100dvh;
      padding-left: env(safe-area-inset-left);
      width: 80%;
      max-width: 320px;
      transform: translateX(-100%);
      transition: transform 150ms ease-out;
      z-index: calc(var(--z-sidebar) + 1);
    }
    .sidebar.open {
      transform: translateX(0);
    }
    .drawer-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-3);
      padding-top: calc(var(--space-2) + env(safe-area-inset-top));
      border-bottom: 1px solid var(--border);
    }
    .drawer-brand {
      font-weight: 600;
      font-size: var(--fs-lg);
      color: var(--text);
    }
    .scrim {
      display: block;
      position: fixed;
      inset: 0;
      background: var(--overlay);
      border: 0;
      padding: 0;
      cursor: pointer;
      z-index: var(--z-sidebar);
    }
    :global(html[data-sidebar="closed"]) .layout.preload .sidebar {
      transform: translateX(-100%);
    }
  }
</style>
