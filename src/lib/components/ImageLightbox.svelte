<script lang="ts">
  import Modal from "./ui/Modal.svelte";
  import {
    imageLightbox,
    closeImageLightbox,
  } from "$lib/client/image-lightbox.svelte";
</script>

<Modal
  open={imageLightbox.open}
  onClose={closeImageLightbox}
  ariaLabel={imageLightbox.alt || "Full-size image"}
  width="min(95vw, 1400px)"
  maxHeight="95vh"
  panelClass="lightbox-panel"
>
  <div class="lightbox">
    <div class="bar">
      <a
        class="btn sm ghost"
        href={imageLightbox.src}
        target="_blank"
        rel="external noopener noreferrer"
      >
        Open original
      </a>
      <button
        class="btn icon ghost sm"
        type="button"
        aria-label="Close"
        onclick={closeImageLightbox}>×</button
      >
    </div>
    <div class="frame">
      <img src={imageLightbox.src} alt={imageLightbox.alt} />
    </div>
    {#if imageLightbox.alt}
      <p class="caption muted small">{imageLightbox.alt}</p>
    {/if}
  </div>
</Modal>

<style>
  .lightbox {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-height: 0;
  }
  .bar {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    align-items: center;
  }
  .frame {
    min-height: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    overflow: auto;
  }
  .frame img {
    max-width: 100%;
    max-height: calc(95vh - 6rem);
    height: auto;
    object-fit: contain;
  }
  .caption {
    margin: 0;
    text-align: center;
    word-break: break-word;
  }
</style>
