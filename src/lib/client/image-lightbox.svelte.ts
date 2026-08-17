// Global, app-wide image lightbox state. A single `ImageLightbox` instance is
// mounted in the root layout; any image surface (chat markdown, tool results,
// permission preview) calls `openImageLightbox` to show the full-size original
// in an accessible modal overlay. Height-capped inline renders keep messages
// readable; the lightbox is the escape hatch for detail.

interface LightboxState {
  open: boolean;
  src: string;
  alt: string;
}

export const imageLightbox = $state<LightboxState>({
  open: false,
  src: "",
  alt: "",
});

/** Show the full-size image in the shared lightbox overlay. */
export function openImageLightbox(src: string, alt = ""): void {
  if (!src) return;
  imageLightbox.src = src;
  imageLightbox.alt = alt;
  imageLightbox.open = true;
}

/** Dismiss the lightbox. */
export function closeImageLightbox(): void {
  imageLightbox.open = false;
}
