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
  import { CircleAlert, Play, Trash2, Video as VideoIcon, VideoOff, X } from '@lucide/svelte';
  import MediaFrame from '$lib/components/shared/MediaFrame.svelte';
  import type { MediaRef } from '$lib/media';
  import { formatVideoTime } from '$lib/utils/videoPlayback';
  import { timeAgo } from '$lib/utils/time';
  import { m } from '$lib/paraglide/messages';
  import UploadAction from './UploadAction.svelte';
  import { uploadCaption } from '$lib/utils/chat/uploadLabel';
  import type { UploadView } from '$lib/utils/chat/uploadProgress.svelte';

  interface Props {
    mediaRef: MediaRef;
    /** The sender's expiry hint has passed: draw the tombstone. */
    expired: boolean;
    senderName: string;
    sentAt: Date;
    /** Same widths as the chat's other media: `w-68` under a caption, `w-56` alone. */
    bleed?: boolean;
    onOpen: () => void;
    /**
     * THE SENDER'S OWN REEL STILL IN ITS OUTBOX (RC-5): preparing, sending, waiting - drawn with the
     * same figure, cancel and retry as any attachment's, over the tile's box. A tile with no
     * `mediaId` has nothing to open, so it never offers the tap.
     */
    upload?: UploadView | null;
    /** The upload was refused for good: says so and offers the delete. */
    uploadFailed?: boolean;
    /** What a failed upload says: the group's reason, or the server's refusal (the default). */
    uploadFailedLabel?: string;
    /** No upload advances it and it never got a `mediaId`: says so and offers the delete. */
    orphan?: boolean;
    onCancelUpload?: () => void;
    onRetryUpload?: () => void;
  }

  let {
    mediaRef,
    expired,
    senderName,
    sentAt,
    bleed = false,
    onOpen,
    upload = null,
    uploadFailed = false,
    uploadFailedLabel = m.upload_failed_label(),
    orphan = false,
    onCancelUpload,
    onRetryUpload,
  }: Props = $props();

  /** Not sent yet: the message is the sender's placeholder, and there is no blob to open. */
  const unsent = $derived(!mediaRef.mediaId);

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
    ? 'bg-cn-scrim/10 dark:bg-text-main/10'
    : 'bg-cn-scrim/30'}"
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
  {:else if unsent}
    <div
      class="absolute inset-0 flex flex-col items-center justify-center gap-2 p-2 text-center text-white"
      role={uploadFailed || orphan ? 'alert' : 'status'}
      data-reel-tile-pending
    >
      {#if uploadFailed || orphan}
        <CircleAlert size={22} class="text-red-err" />
        <p class="text-2xs leading-tight font-semibold">
          {uploadFailed ? uploadFailedLabel : m.media_orphan_label()}
        </p>
        {#if onCancelUpload}
          <button
            type="button"
            onclick={(e) => {
              e.stopPropagation();
              onCancelUpload();
            }}
            aria-label={m.upload_delete_label()}
            title={m.upload_delete_label()}
            class="ui-icon-button rounded-xl outline-none hover:bg-current/10 focus-visible:ring-2 focus-visible:ring-current"
          >
            <Trash2 size={18} strokeWidth={2.5} />
          </button>
        {/if}
      {:else if upload}
        <UploadAction view={upload} onCancel={onCancelUpload} onRetry={onRetryUpload} />
        <p class="text-2xs bg-cn-scrim/50 rounded-full px-2 py-0.5 leading-tight font-semibold">
          {uploadCaption(upload, mediaRef.size)}
        </p>
      {:else}
        <!-- Queued with no transfer running yet (a lane busy, a relaunch not restarted): still the
             sender's to withdraw, so the cancel is offered here too, never only once bytes move. -->
        <VideoIcon size={32} class="animate-pulse opacity-40" />
        {#if onCancelUpload}
          <button
            type="button"
            onclick={(e) => {
              e.stopPropagation();
              onCancelUpload();
            }}
            aria-label={m.upload_cancel_label()}
            title={m.upload_cancel_label()}
            class="ui-icon-button bg-cn-scrim/50 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-current"
          >
            <X size={18} strokeWidth={2.5} />
          </button>
        {/if}
      {/if}
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
      class="focus-visible:ring-cn-yellow absolute inset-0 flex flex-col items-center justify-center gap-2 text-white outline-none focus-visible:ring-2 focus-visible:ring-inset"
      data-reel-tile
    >
      <span
        class="bg-cn-scrim/50 flex h-14 w-14 items-center justify-center rounded-full transition-transform duration-300 md:group-hover/media:scale-110"
      >
        <Play size={26} strokeWidth={2.25} fill="currentColor" />
      </span>
      <span class="bg-cn-scrim/50 rounded-full px-3 py-1 text-xs font-semibold">
        {m.reel_chat_tile_tap()}
      </span>
      {#if duration}
        <span
          class="bg-cn-scrim/50 absolute right-2.5 bottom-2.5 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums"
        >
          {duration}
        </span>
      {/if}
    </button>
  {/if}
</MediaFrame>
