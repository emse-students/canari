<script lang="ts">
  import { ImageOff } from '@lucide/svelte';
  import { MediaService, type MediaRef } from '$lib/media';
  import { nearViewport } from '$lib/actions/nearViewport';
  import type { SpacePoster } from '$lib/bookings/api';
  import { releaseDecryptedMediaBlobUrl } from '$lib/utils/mediaBlobCache';
  import { logMediaFailure, mediaFailureCause } from '$lib/utils/mediaErrors';
  import { m } from '$lib/paraglide/messages';

  /**
   * A SPACE'S POSTER (D35), decrypted on this device like a post's image: the server and the media
   * service hold ciphertext only. The box is reserved at the poster's own proportions (recorded at
   * upload) so nothing below it moves when the picture arrives. The decrypted URL comes from the
   * shared blob cache and is released when the poster changes or the component unmounts.
   *
   * AS A THUMBNAIL (`thumb`, D45) it is the small square of a list row. A list of spaces holds one
   * poster each, and decrypting every one on arrival would put the whole list's downloads and
   * decryptions ahead of what the reader sees, so a thumbnail starts only once it is NEAR the
   * viewport (`nearViewport`, once - the picture stays after it is scrolled past).
   */
  interface Props {
    poster: SpacePoster;
    /** Says whose poster it is, for a screen reader. Empty for a thumbnail the row's text names. */
    alt: string;
    /** A small square for a list row, decrypted only when near the viewport. */
    thumb?: boolean;
    /**
     * Fills a box the CALLER sizes (the banner of a space card, WP-R3b): cover-fitted, no border of
     * its own, and decrypted only once near the viewport like a thumbnail.
     */
    cover?: boolean;
  }

  let { poster, alt, thumb = false, cover = false }: Props = $props();

  let url = $state<string | null>(null);
  let failed = $state(false);
  /** A banner is wanted at once; a thumbnail once it is near the viewport. */
  let near = $state(false);
  const wanted = $derived(!(thumb || cover) || near);
  const ratio = $derived(
    poster.width && poster.height ? `${poster.width} / ${poster.height}` : '16 / 9'
  );

  $effect(() => {
    if (!wanted) return;
    const ref: MediaRef = { ...poster };
    let destroyed = false;
    let acquired = false;
    failed = false;
    const abort = new AbortController();
    new MediaService()
      .downloadAndDecrypt(ref, abort.signal)
      .then((objectUrl) => {
        if (destroyed) releaseDecryptedMediaBlobUrl(ref);
        else {
          url = objectUrl;
          acquired = true;
        }
      })
      .catch((err) => {
        if (destroyed) return;
        failed = true;
        logMediaFailure('SpacePoster', mediaFailureCause(err), ref.mediaId, err);
      });
    return () => {
      destroyed = true;
      abort.abort();
      if (acquired) releaseDecryptedMediaBlobUrl(ref);
      url = null;
    };
  });
</script>

<div
  use:nearViewport={{ onnear: () => (near = true) }}
  class="bg-cn-bg relative overflow-hidden {cover
    ? 'h-full w-full'
    : `border-cn-border/60 rounded-xl border ${thumb ? 'size-12 shrink-0' : 'max-h-80 w-full md:max-h-56'}`}"
  style:aspect-ratio={thumb || cover ? undefined : ratio}
>
  {#if url}
    <img src={url} {alt} class="h-full w-full object-cover" />
  {:else if failed}
    {#if thumb || cover}
      <div
        class="text-text-muted flex h-full w-full items-center justify-center"
        aria-hidden="true"
      >
        <ImageOff size={18} />
      </div>
    {:else}
      <div
        class="text-text-muted flex h-full w-full items-center justify-center gap-2 text-xs"
        role="img"
        aria-label={m.bookings_poster_load_error()}
      >
        <ImageOff size={18} />{m.bookings_poster_load_error()}
      </div>
    {/if}
  {:else}
    <div class="h-full w-full animate-pulse bg-black/10 dark:bg-white/10"></div>
  {/if}
</div>
