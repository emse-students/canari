<script lang="ts">
  import { MediaService } from '$lib/media';
  import type { MediaRef } from '$lib/media';
  import { releaseDecryptedMediaBlobUrl } from '$lib/utils/mediaBlobCache';
  import {
    logMediaFailure,
    mediaFailureCause,
    type MediaFailureCause,
  } from '$lib/utils/mediaErrors';
  import { mediaFailureLabel } from '$lib/utils/mediaFailureLabel';
  import { Play, ImageOff } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { nearViewport } from '$lib/actions/nearViewport';

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
  /** Why the tile has no picture, typed at the throw; the viewer it opens offers the retry. */
  let failure = $state<MediaFailureCause | null>(null);
  /** Purged by the 30-day retention: permanent, and worth saying so rather than showing a gap. */
  const expired = $derived(failure === 'expired');
  /** The tile is ~5rem wide: the sentence goes on its name and tooltip. */
  const failureLabel = $derived(
    failure
      ? mediaFailureLabel(failure, {
          expired: m.msg_media_expired_label(),
          other: m.msg_image_load_error(),
        })
      : undefined
  );

  /**
   * Whether this tile has come near the viewport. The panel mounts its grid in a window of 60,
   * and that is a BOUND, not a concurrency limit: every one of the sixty used to fire a full-size
   * download in the same frame, and they are originals rather than thumbnails. A tile nobody has
   * scrolled to now asks for nothing at all, and what it does ask for goes through
   * `mediaRequestGate` three at a time.
   */
  let isNear = $state(false);

  // Decrypt this single item; released on destroy.
  $effect(() => {
    const ref = media;
    // Gate on the session being authenticated; the download resolves its own live token.
    if (!authToken || !isNear) return;
    let destroyed = false;
    let acquired = false;
    failure = null;
    // Abandons the request while it is still QUEUED, so a tile scrolled past never asks.
    const abort = new AbortController();
    new MediaService()
      .downloadAndDecrypt(ref, abort.signal)
      .then((url) => {
        if (destroyed) releaseDecryptedMediaBlobUrl(ref);
        else {
          blobUrl = url;
          acquired = true;
        }
      })
      .catch((err) => {
        if (destroyed) return;
        failure = mediaFailureCause(err);
        logMediaFailure('SharedMediaThumb', failure, ref.mediaId, err);
      });
    return () => {
      destroyed = true;
      abort.abort();
      if (acquired) releaseDecryptedMediaBlobUrl(ref);
      blobUrl = null;
    };
  });
</script>

<button
  type="button"
  onclick={onClick}
  use:nearViewport={{ onnear: () => (isNear = true) }}
  class="relative aspect-square w-full overflow-hidden rounded-lg bg-black/5 transition-opacity outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-amber-500 dark:bg-white/10"
  aria-label={failureLabel ?? m.chat_open_media_label()}
  title={failureLabel}
>
  {#if failure}
    <div
      class="text-text-muted flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-center"
    >
      <ImageOff size={18} />
      {#if expired}
        <!-- The tile is ~5rem wide: the short label fits, the sentence is on the tooltip. -->
        <span class="text-2xs leading-tight">{m.msg_expired_label()}</span>
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
