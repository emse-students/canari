<script lang="ts">
  import { MediaService } from '$lib/media';
  import type { MediaRef } from '$lib/media';
  import { releaseDecryptedMediaBlobUrl } from '$lib/utils/mediaBlobCache';
  import { Play, ImageOff } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Encrypted media reference to decrypt and preview. */
    media: MediaRef;
    /** Bearer token forwarded to MediaService for download + decryption. */
    authToken: string;
    /** Called when the thumbnail is clicked (opens the gallery lightbox). */
    onClick?: () => void;
  }

  let { media, authToken, onClick }: Props = $props();

  let blobUrl = $state<string | null>(null);
  let failed = $state(false);

  // Decrypt this single item; released on destroy. Rendering the grid in a bounded
  // window (see panel) keeps the number of concurrent decryptions reasonable.
  $effect(() => {
    const ref = media;
    const token = authToken;
    if (!token) return;
    let destroyed = false;
    let acquired = false;
    failed = false;
    new MediaService()
      .downloadAndDecrypt(ref, token)
      .then((url) => {
        if (destroyed) releaseDecryptedMediaBlobUrl(ref);
        else {
          blobUrl = url;
          acquired = true;
        }
      })
      .catch(() => {
        if (!destroyed) failed = true;
      });
    return () => {
      destroyed = true;
      if (acquired) releaseDecryptedMediaBlobUrl(ref);
      blobUrl = null;
    };
  });
</script>

<button
  type="button"
  onclick={onClick}
  class="relative aspect-square w-full overflow-hidden rounded-lg bg-black/5 dark:bg-white/10 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 hover:opacity-90 transition-opacity"
  aria-label={m.chat_open_media_label()}
>
  {#if failed}
    <div class="flex h-full w-full items-center justify-center text-text-muted">
      <ImageOff size={18} />
    </div>
  {:else if blobUrl}
    {#if media.type === 'video'}
      <video src={blobUrl} class="h-full w-full object-cover" muted playsinline preload="metadata"
      ></video>
      <span
        class="absolute inset-0 flex items-center justify-center bg-black/20 text-white pointer-events-none"
      >
        <Play size={20} fill="currentColor" />
      </span>
    {:else}
      <img src={blobUrl} alt={media.fileName ?? 'media'} class="h-full w-full object-cover" />
    {/if}
  {:else}
    <div class="h-full w-full animate-pulse bg-black/10 dark:bg-white/10"></div>
  {/if}
</button>
