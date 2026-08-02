<script lang="ts">
  import type { Snippet } from 'svelte';
  import { renderPdfFirstPage, releasePdfThumbnail } from '$lib/utils/pdfThumbnail';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Object URL of the already-decrypted PDF. */
    url: string;
    /** CSS width the thumbnail is displayed at, used to size the rendered bitmap. */
    maxWidth: number;
    /** Classes applied to the rendered image (the caller owns the framing). */
    imgClass?: string;
    /** Shown while rendering and whenever rendering fails - typically the file icon. */
    fallback?: Snippet;
  }

  let { url, maxWidth, imgClass = '', fallback }: Props = $props();

  let thumbnailUrl = $state<string | null>(null);

  $effect(() => {
    const source = url;
    let current: string | null = null;
    let cancelled = false;

    renderPdfFirstPage(source, maxWidth)
      .then((rendered) => {
        if (cancelled) {
          releasePdfThumbnail(rendered);
          return;
        }
        current = rendered;
        thumbnailUrl = rendered;
      })
      .catch((err) => {
        // A preview is a bonus: an unreadable or encrypted PDF keeps the icon
        // and, crucially, keeps its download button.
        console.debug('[pdfThumbnail] first page could not be rendered', err);
      });

    return () => {
      cancelled = true;
      releasePdfThumbnail(current);
      current = null;
      thumbnailUrl = null;
    };
  });
</script>

{#if thumbnailUrl}
  <img src={thumbnailUrl} alt={m.pdf_preview_alt()} class={imgClass} />
{:else if fallback}
  {@render fallback()}
{/if}
