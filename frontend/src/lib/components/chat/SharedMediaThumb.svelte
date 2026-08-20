<script lang="ts">
  import { MediaService } from '$lib/media';
  import type { MediaRef } from '$lib/media';
  import { releaseDecryptedMediaBlobUrl } from '$lib/utils/mediaBlobCache';
  import { isMediaPurgedError } from '$lib/utils/mediaErrors';
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
  /** Purged by the 30-day retention: permanent, and worth saying so rather than showing a gap. */
  let expired = $state(false);

  // Decrypt this single item; released on destroy. Rendering the grid in a bounded
  // window (see panel) keeps the number of concurrent decryptions reasonable.
  $effect(() => {
    const ref = media;
    // Gate on the session being authenticated; the download resolves its own live token.
    if (!authToken) return;
    let destroyed = false;
    let acquired = false;
    failed = false;
    expired = false;
    new MediaService()
      .downloadAndDecrypt(ref)
      .then((url) => {
        if (destroyed) releaseDecryptedMediaBlobUrl(ref);
        else {
          blobUrl = url;
          acquired = true;
        }
      })
      .catch((err) => {
        if (destroyed) return;
        expired = isMediaPurgedError(err);
        failed = true;
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
  class="relative aspect-square w-full overflow-hidden rounded-lg bg-black/5 transition-opacity outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-amber-500 dark:bg-white/10"
  aria-label={expired ? m.msg_media_expired_label() : m.chat_open_media_label()}
  title={expired ? m.msg_media_expired_label() : undefined}
>
  {#if failed}
    <div
      class="text-text-muted flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-center"
    >
      <ImageOff size={18} />
      {#if expired}
        <!-- The tile is ~5rem wide: the short label fits, the sentence is on the tooltip. -->
        <span class="text-[0.625rem] leading-tight">{m.msg_expired_label()}</span>
      {/if}
    </div>
  {:else if blobUrl}
    {#if media.type === 'video'}
      <video src={blobUrl} class="h-full w-full object-cover" muted playsinline preload="metadata"
      ></video>
      <span
        class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20 text-white"
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
