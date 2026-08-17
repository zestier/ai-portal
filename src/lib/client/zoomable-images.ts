// Svelte action that makes content images inside a rendered markdown container
// click-to-zoom. Markdown is sanitized HTML injected via `{@html}`, so there
// are no Svelte bindings to hang handlers off of (mirrors `copyableCodeBlocks`):
// we post-process the already-sanitized DOM, marking each <img> as a focusable,
// keyboard-activatable trigger that opens the shared lightbox. A MutationObserver
// re-decorates after streaming re-renders; decoration is idempotent.

import { openImageLightbox } from "./image-lightbox.svelte";

function decorateImg(img: HTMLImageElement): void {
  if (img.dataset.zoomDecorated === "true") return;
  img.dataset.zoomDecorated = "true";

  img.style.cursor = "zoom-in";
  img.setAttribute("role", "button");
  img.setAttribute("tabindex", "0");
  if (!img.title) img.title = "Click to view full size";

  img.addEventListener("click", () =>
    openImageLightbox(img.currentSrc || img.src, img.alt),
  );
  img.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openImageLightbox(img.currentSrc || img.src, img.alt);
    }
  });
}

export function zoomableImages(node: HTMLElement) {
  const decorate = (): void =>
    node
      .querySelectorAll("img")
      .forEach((img) => decorateImg(img as HTMLImageElement));

  const observer =
    typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => decorate())
      : null;

  decorate();
  observer?.observe(node, { childList: true, subtree: true });

  return {
    update: decorate,
    destroy: () => observer?.disconnect(),
  };
}
