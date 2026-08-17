// Svelte action that adds a hover-revealed "copy to clipboard" button to every
// multi-line code block (`<pre>`) inside a rendered container.
//
// Why an action and not a custom `marked` renderer: the markdown is rendered to
// a sanitized HTML string and injected via `{@html}`, so there are no Svelte
// bindings to hang a button off of, and any markup a custom renderer emitted
// would have to survive DOMPurify. Instead we post-process the already-sanitized
// DOM on the client: find each `<pre>`, wrap it in a positioning context, and
// inject a real `<button>`.
//
// Streaming assistant/subagent messages re-render their `{@html}` content
// frequently, which replaces the children (and thus our injected buttons). A
// `MutationObserver` re-runs decoration whenever the container's subtree
// changes. Decoration is idempotent (guarded per `<pre>`), so it converges and
// stops firing once every block is decorated.

import { trimOneTrailingNewline, writeClipboard } from "./copy-helper";

const COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M10 1H4a1 1 0 0 0-1 1v8h1.5V2.5h5.5V1zM12 4H7a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1zm-.5 9.5h-4v-8h4v8z"/></svg>';
const CHECK_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-6.25 6.25a.75.75 0 0 1-1.06 0L2.72 8.03a.75.75 0 0 1 1.06-1.06L7 10.19l5.72-5.97a.75.75 0 0 1 1.06 0z"/></svg>';

// Parse each compile-time SVG constant into a DOM node once, then hand out
// clones. This avoids assigning innerHTML on dynamically created nodes.
let copyIconNode: SVGElement | null = null;
let checkIconNode: SVGElement | null = null;

function parseSvg(svg: string): SVGElement {
  return new DOMParser().parseFromString(svg, "image/svg+xml")
    .documentElement as unknown as SVGElement;
}

function setIcon(btn: HTMLElement, which: "copy" | "check"): void {
  if (which === "copy") {
    copyIconNode ??= parseSvg(COPY_ICON);
    btn.replaceChildren(copyIconNode.cloneNode(true));
  } else {
    checkIconNode ??= parseSvg(CHECK_ICON);
    btn.replaceChildren(checkIconNode.cloneNode(true));
  }
}

const STYLE_ID = "copyable-code-blocks-styles";

const STYLE = `
.copy-code-wrap { position: relative; }
.copy-code-btn {
	position: absolute;
	top: var(--space-2);
	right: var(--space-2);
	display: inline-flex;
	align-items: center;
	justify-content: center;
	padding: 4px;
	border: 1px solid var(--border);
	border-radius: var(--radius-sm);
	background: var(--surface-2);
	color: var(--text-muted);
	cursor: pointer;
	opacity: 0;
	transition: opacity 0.12s ease, color 0.12s ease, background 0.12s ease;
	z-index: 2;
}
.copy-code-wrap:hover .copy-code-btn,
.copy-code-wrap:focus-within .copy-code-btn,
.copy-code-btn:focus-visible { opacity: 1; }
.copy-code-btn:hover { color: var(--text); background: var(--surface); }
.copy-code-btn:focus-visible { outline: var(--focus-ring); }
.copy-code-btn[data-state='copied'] { color: var(--success); opacity: 1; }
.copy-code-btn[data-state='failed'] { color: var(--danger); opacity: 1; }
.copy-code-btn svg { display: block; }
.copy-code-status {
	position: absolute;
	top: var(--space-2);
	right: calc(var(--space-2) + 30px);
	font-size: var(--fs-xs);
	color: var(--danger);
	background: var(--surface-2);
	border: 1px solid var(--border);
	padding: 2px 6px;
	border-radius: var(--radius-sm);
	pointer-events: none;
	z-index: 2;
}
.copy-code-status:empty { display: none; }
.copy-code-live {
	position: absolute;
	width: 1px;
	height: 1px;
	padding: 0;
	margin: -1px;
	overflow: hidden;
	clip: rect(0 0 0 0);
	white-space: nowrap;
	border: 0;
}
`;

function ensureStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLE;
  document.head.appendChild(el);
}

export function copyableCodeBlocks(node: HTMLElement) {
  ensureStyles();

  const timers = new Set<ReturnType<typeof setTimeout>>();
  let live: HTMLElement | null = null;

  // One visually-hidden polite live region per container. Recreated if a
  // re-render of the host's {@html} content detached the previous one.
  function announce(message: string): void {
    if (!live || !node.contains(live)) {
      live = document.createElement("span");
      live.className = "copy-code-live";
      live.setAttribute("aria-live", "polite");
      node.appendChild(live);
    }
    live.textContent = message;
  }

  function decoratePre(pre: HTMLElement): void {
    if (pre.dataset.copyDecorated === "true") return;
    pre.dataset.copyDecorated = "true";

    // Wrap the <pre> so the button anchors to a non-scrolling context: the
    // <pre> itself scrolls horizontally, the wrapper does not, so the button
    // stays pinned top-right instead of scrolling out of view.
    const parent = pre.parentNode;
    if (!parent) return;
    const wrap = document.createElement("div");
    wrap.className = "copy-code-wrap";
    parent.insertBefore(wrap, pre);
    wrap.appendChild(pre);

    const status = document.createElement("span");
    status.className = "copy-code-status";
    status.setAttribute("aria-hidden", "true");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-code-btn";
    btn.setAttribute("aria-label", "Copy code");
    setIcon(btn, "copy");

    const reset = (): void => {
      delete btn.dataset.state;
      setIcon(btn, "copy");
      btn.setAttribute("aria-label", "Copy code");
      status.textContent = "";
    };

    btn.addEventListener("click", () => {
      // Read text from the inner <code> when present (the injected button and
      // status live in the wrapper, never inside <code>, so this stays clean).
      const code = pre.querySelector("code");
      const raw = (code ?? pre).textContent ?? "";
      const text = trimOneTrailingNewline(raw);
      void writeClipboard(text).then((ok) => {
        if (ok) {
          btn.dataset.state = "copied";
          setIcon(btn, "check");
          btn.setAttribute("aria-label", "Copied");
          status.textContent = "";
          announce("Copied");
        } else {
          btn.dataset.state = "failed";
          status.textContent = "Copy failed";
          announce("Copy failed");
        }
        const timer = setTimeout(() => {
          timers.delete(timer);
          reset();
          announce("");
        }, 1500);
        timers.add(timer);
      });
    });

    wrap.appendChild(status);
    wrap.appendChild(btn);
  }

  function decorate(): void {
    node
      .querySelectorAll("pre")
      .forEach((pre) => decoratePre(pre as HTMLElement));
  }

  const observer =
    typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => decorate())
      : null;

  decorate();
  observer?.observe(node, { childList: true, subtree: true });

  return {
    update() {
      decorate();
    },
    destroy() {
      observer?.disconnect();
      timers.forEach(clearTimeout);
      timers.clear();
    },
  };
}
