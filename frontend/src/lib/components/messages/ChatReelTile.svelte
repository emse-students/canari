<script lang="ts">
  /**
   * A CanaReel received in a conversation: a 9:16 tile, never a player
   * ([reels-in-chat](docs/wiki/frontend/modules/reels-in-chat.md), Snapchat's).
   *
   * NOTHING IS FETCHED BEFORE THE TAP. A reel is 9-35 MB and the chat reads media whole, so a tile
   * that downloaded on arrival would spend a member's mobile data on a message they may never
   * open. The box is drawn from what the MESSAGE declares (size, ThumbHash, length), and the viewer
   * the tap opens does the download and the streaming.
   *
   * REPLAYABLE for the 30 days of the blob's life (user, 2026-10-09: no view-once). Once the
   * sender's expiry hint has passed it is a TOMBSTONE: the same box, no blurred ghost of the video,
   * and the age only (no "N days left" chip). The server's 410 remains the truth for an early loss.
   */
  import { Play, VideoOff } from '@lucide/svelte';
  import MediaFrame from '$lib/components/shared/MediaFrame.svelte';
  import type { MediaRef } from '$lib/media';
  import { formatVideoTime } from '$lib/utils/videoPlayback';
  import { timeAgo } from '$lib/utils/time';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    mediaRef: MediaRef;
    /** The sender's expiry hint has passed: draw the tombstone. */
    expired: boolean;
    senderName: string;
    sentAt: Date;
    /** Same widths as the chat's other media: `w-68` under a caption, `w-56` alone. */
    bleed?: boolean;
    onOpen: () => void;
  }

  let { mediaRef, expired, senderName, sentAt, bleed = false, onOpen }: Props = $props();

  const age = $derived(timeAgo(sentAt.toISOString()));
  const duration = $derived(
    mediaRef.durationMs && mediaRef.durationMs > 0
      ? formatVideoTime(mediaRef.durationMs / 1000)
      : ''
  );
  const label = $derived(
    expired
      ? m.reel_chat_tile_label_expired({ name: senderName, age })
      : m.reel_chat_tile_label({ name: senderName, duration: duration || '0:00', age })
  );
</script>

<MediaFrame
  width={mediaRef.width}
  height={mediaRef.height}
  fallbackAspect={9 / 16}
  placeholder={expired ? undefined : mediaRef.placeholder}
  class="group/media max-w-full {bleed ? 'w-68' : 'w-56 rounded-3xl'} {expired
    ? 'bg-black/10 dark:bg-white/10'
    : 'bg-black/30'}"
>
  {#if expired}
    <!-- The tombstone is not a control: nothing opens, there is nothing left to open. -->
    <div
      class="text-text-muted absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center"
      role="img"
      aria-label={label}
      data-reel-tombstone
    >
      <VideoOff size={28} class="opacity-60" />
      <span class="text-sm font-semibold">{m.reel_chat_expired()}</span>
      <span class="text-xs opacity-70">{m.reel_chat_expired_age({ age })}</span>
    </div>
  {:else}
    <button
      type="button"
      onclick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onpointerdown={(e) => e.stopPropagation()}
      aria-label={label}
      class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-inset"
      data-reel-tile
    >
      <span
        class="flex h-14 w-14 items-center justify-center rounded-full bg-black/50 transition-transform duration-300 md:group-hover/media:scale-110"
      >
        <Play size={26} strokeWidth={2.25} fill="currentColor" />
      </span>
      <span class="rounded-full bg-black/50 px-3 py-1 text-xs font-semibold">
        {m.reel_chat_tile_tap()}
      </span>
      {#if duration}
        <span
          class="absolute right-2.5 bottom-2.5 rounded-full bg-black/50 px-2 py-0.5 text-xs font-semibold tabular-nums"
        >
          {duration}
        </span>
      {/if}
    </button>
  {/if}
</MediaFrame>
