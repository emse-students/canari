<script lang="ts">
  /**
   * The full-screen viewer over a LIST of a conversation's images and videos: previous and next
   * (arrows, swipe and Left/Right are {@link MediaLightbox}'s), the current item decrypted on
   * demand. Shared by the "Medias" panel and the chat bubbles, so the two cannot drift.
   *
   * The current item is held by its KEY, not its index: the chat opens on the one item it already
   * decrypted and the whole list arrives a moment later (a local read), possibly changing every
   * index. The viewer stays on the same item and only gains neighbours - no remount, no second
   * history entry.
   *
   * Moving swaps the player for the next item's, which unmounts the previous video and so stops it.
   */
  import { untrack } from 'svelte';
  import VideoPlayer from '../shared/VideoPlayer.svelte';
  import MediaLightbox from '../shared/MediaLightbox.svelte';
  import MediaLoadFailure from '../shared/MediaLoadFailure.svelte';
  import { MediaService } from '$lib/media';
  import { releaseDecryptedMediaBlobUrl } from '$lib/utils/mediaBlobCache';
  import {
    logMediaFailure,
    mediaFailureCause,
    type MediaFailureCause,
  } from '$lib/utils/mediaErrors';
  import { downloadDecryptedFile } from '$lib/utils/fileDownload';
  import { viewerBounds, viewerItemKey } from '$lib/utils/chat/viewerSequence';
  import type { SharedMediaItem } from '$lib/utils/chat/sharedContent';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** In navigation order: index - 1 is "previous" (the arrow on the left). */
    items: SharedMediaItem[];
    /** The key (`viewerItemKey`) of the item to open on. */
    startKey: string;
    onClose: () => void;
    /** Non-empty once the session is authenticated; a download resolves its own live token. */
    authToken: string;
    /** An item the caller already decrypted: shown as is, and never released here (it is theirs). */
    known?: { key: string; url: string } | null;
  }

  let { items, startKey, onClose, authToken, known = null }: Props = $props();

  // svelte-ignore state_referenced_locally
  let currentKey = $state(startKey);
  const index = $derived(items.findIndex((item) => viewerItemKey(item) === currentKey));
  const current = $derived(index >= 0 ? items[index] : undefined);
  const bounds = $derived(viewerBounds(items.length, index));

  // Keyed by the item they belong to: a stale url must never be drawn for the item moved to.
  let loaded = $state<{ key: string; url: string } | null>(null);
  let failed = $state<{ key: string; cause: MediaFailureCause } | null>(null);
  const url = $derived(loaded && loaded.key === currentKey ? loaded.url : null);
  const failure = $derived(failed && failed.key === currentKey ? failed.cause : null);
  /** Bumped by the viewer's "Reessayer"; the decrypt effect reads it and runs again. */
  let attempt = $state(0);

  function go(delta: -1 | 1) {
    const target = items[index + delta];
    if (!target) return;
    Log.d(
      'ConversationMediaViewer',
      `move ${delta < 0 ? 'previous' : 'next'}: ${index} -> ${index + delta} of ${items.length}`
    );
    currentKey = viewerItemKey(target);
  }

  $effect(() => {
    void attempt;
    // Keyed on the item, not the list: the list arriving later must not restart the decrypt.
    const key = currentKey;
    const item = untrack(() => items.find((candidate) => viewerItemKey(candidate) === key));
    if (!item) return;
    if (known && known.key === key) {
      loaded = { key, url: known.url };
      failed = null;
      return;
    }
    if (!authToken) return;
    const ref = item.media;
    let destroyed = false;
    let acquired = false;
    loaded = null;
    failed = null;
    new MediaService()
      .downloadAndDecrypt(ref)
      .then((decrypted) => {
        if (destroyed) releaseDecryptedMediaBlobUrl(ref);
        else {
          loaded = { key, url: decrypted };
          acquired = true;
        }
      })
      .catch((err) => {
        if (destroyed) return;
        const cause = mediaFailureCause(err);
        failed = { key, cause };
        logMediaFailure('ConversationMediaViewer', cause, ref.mediaId, err);
      });
    return () => {
      destroyed = true;
      if (acquired) releaseDecryptedMediaBlobUrl(ref);
    };
  });
</script>

{#if current}
  <MediaLightbox
    open={true}
    {onClose}
    title={current.media.fileName ?? current.caption ?? ''}
    info={{
      senderId: current.senderId,
      sentAt: current.timestamp,
      fileName: current.media.fileName,
      sizeBytes: current.media.size,
      width: current.media.width,
      height: current.media.height,
    }}
    onDownload={url
      ? () => void downloadDecryptedFile(url!, current.media.fileName ?? 'media')
      : undefined}
    showPrev={bounds.showPrev}
    showNext={bounds.showNext}
    onPrev={() => go(-1)}
    onNext={() => go(1)}
    dotCount={0}
  >
    {#if url}
      {#key currentKey}
        {#if current.media.type === 'video'}
          <VideoPlayer
            src={url}
            variant="conversation"
            soundScope="local"
            loudness={current.media.loudness}
            class="h-full w-full"
          />
        {:else}
          <img
            src={url}
            alt={current.media.fileName ?? m.conversation_media_fallback_alt()}
            class="max-h-full max-w-full object-contain select-none"
          />
        {/if}
      {/key}
    {:else if failure}
      <div class="p-6">
        <MediaLoadFailure
          cause={failure}
          expiredLabel={m.msg_media_expired_label()}
          otherLabel={m.msg_image_load_error()}
          onRetry={() => (attempt += 1)}
          tone="dark"
        />
      </div>
    {:else}
      <div
        class="h-10 w-10 animate-spin rounded-full border-4 border-white/70 border-t-transparent"
      ></div>
    {/if}
  </MediaLightbox>
{/if}
