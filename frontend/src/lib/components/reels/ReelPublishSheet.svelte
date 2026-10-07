<script lang="ts">
  import { resolve } from '$app/paths';
  /**
   * The CanaReels publish step (R3): a caption and the same "who is publishing" choice a post has
   * (`PostIdentityPicker`), over the take it publishes. "Publier" re-encodes the take on the device
   * (`prepareVideoForUpload`, with its progress line and its cancel), uploads it under the `reel`
   * class and creates the reel (`publishReel`), then lands on the feed.
   *
   * IT IS A HISTORY ENTRY, so Android's Back (and iOS's edge swipe) returns to the take rather than
   * leaving the camera; a Back during the re-encode also stops it. Once the upload has begun nothing
   * is cancelled: the reel is being created, and the feed it lands on is where it appears.
   */
  import { onDestroy, onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { ChevronLeft, CircleAlert } from '@lucide/svelte';
  import { goto } from '$app/navigation';
  import PostIdentityPicker from '$lib/components/posts/PostIdentityPicker.svelte';
  import VideoPoster from '$lib/components/shared/VideoPoster.svelte';
  import VideoPreparationProgress from '$lib/components/shared/VideoPreparationProgress.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import type { Association } from '$lib/associations/api';
  import type { ReelLimits } from '$lib/posts/api';
  import { listPostAsAssociations } from '$lib/posts/postIdentity';
  import { publishFailureMessage, type PublishStage } from '$lib/posts/publishFailure';
  import type { ReelClip } from '$lib/reels/reelCapture';
  import {
    publishCameraPhoto,
    publishReel,
    ReelPublishError,
    type PublishReelDeps,
  } from '$lib/reels/publishReel';
  import { showToast } from '$lib/stores/toast.svelte';
  import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';
  import { trimComposerText } from '$lib/utils/markdown/composerText';
  import { bindHistoryOverlay } from '$lib/utils/bindHistoryOverlay.svelte';
  import { isVideoPrepareError } from '$lib/video/prepareVideoForUpload';
  import { VideoPreparationState } from '$lib/video/videoPreparationState.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    clip: ReelClip;
    limits: ReelLimits;
    /** Back to the take. */
    onclose: () => void;
    /** Injectable for tests; the real services otherwise. */
    deps?: PublishReelDeps;
  }

  let { clip, limits, onclose, deps }: Props = $props();

  let caption = $state('');
  let identity = $state('');
  let associations = $state<Association[]>([]);
  let publishing = $state(false);
  let stage = $state<PublishStage | null>(null);
  let errorMessage = $state('');
  /** The preview's first frame is decoded: Canari's poster gives way to it. */
  let previewReady = $state(false);
  const preparation = new VideoPreparationState();

  const overlay = bindHistoryOverlay(
    () => true,
    () => {
      // Only a publish that has not reached the upload has anything to cancel. Cancelling after it
      // (the landing on the feed closes this sheet too) logged "cancelled by the member" for a reel
      // that had just been published (REEL-2 on the Mi 9T, 2026-10-02).
      const cancellable = publishing && stage !== 'mediaUpload' && stage !== 'createPost';
      console.debug(
        `[reel-publish] the sheet was dismissed${cancellable ? ', publish cancelled' : ''}`
      );
      if (cancellable) preparation.cancel();
      onclose();
    }
  );

  // One URL per clip for the thumbnail, revoked with it (the same shape as `ReelReview`).
  const src = $derived(URL.createObjectURL(clip.blob));
  let previous: string | null = null;
  $effect(() => {
    if (previous && previous !== src) URL.revokeObjectURL(previous);
    previous = src;
  });

  onMount(() => {
    overlay.syncOpen();
    void (async () => {
      try {
        associations = await listPostAsAssociations();
      } catch (err) {
        // The member can still publish as themself; the list only adds choices.
        console.error('[reel-publish] the associations could not be listed', err);
      }
    })();
  });

  onDestroy(() => {
    if (previous) URL.revokeObjectURL(previous);
  });

  async function publish() {
    console.debug('[reel-publish] publish pressed');
    publishing = true;
    errorMessage = '';
    caption = trimComposerText(caption);
    const options = preparation.optionsFor(undefined);
    try {
      const onStage = (next: PublishStage) => {
        stage = next;
        // The re-encode is over once the upload starts: its line comes down, its cancel with it.
        if (next === 'mediaUpload') preparation.finish();
      };
      if (clip.blob.type.startsWith('image/')) {
        await publishCameraPhoto({ clip, caption, identity, onStage });
      } else {
        await publishReel(
          {
            clip,
            caption,
            identity,
            maxDurationMs: limits.maxDurationMs,
            video: { onProgress: options.onProgress, signal: options.signal },
            onStage,
          },
          deps
        );
      }
      showToast(m.reels_publish_done(), 'info');
      await goto(resolve('/posts'), { replaceState: true });
    } catch (err) {
      const cause = err instanceof ReelPublishError ? err.cause : err;
      if (isVideoPrepareError(cause) && cause.fault === 'aborted') {
        console.debug('[reel-publish] stopped: the re-encode was cancelled');
        return;
      }
      const where = err instanceof ReelPublishError ? err.stage : 'unknown';
      console.error(`[reel-publish] failed at ${where}`, cause);
      errorMessage = publishFailureMessage(cause, m.reels_publish_error());
    } finally {
      preparation.finish();
      publishing = false;
      stage = null;
    }
  }

  const busyLabel = $derived(
    stage === 'mediaUpload' || stage === 'createPost' ? m.reels_publish_uploading() : null
  );
</script>

<div
  class="bg-cn-bg text-text-main absolute inset-0 z-20 flex flex-col"
  in:fade={{ duration: 150 }}
  data-reel-publish
>
  <!-- THE SAFE-AREA PADDING IS ITS OWN, AND ONLY ITS OWN: the camera place is full-bleed (the shell
       gives its top padding back there, `app.css`), so the header's surface paints under the status
       bar and its content clears it. When the shell padded too, the title stood 47pt too low on the
       iPhone (read 2026-10-02) - one inset, owned here, never two. -->
  <header
    class="border-cn-border bg-cn-surface flex shrink-0 items-center gap-2 border-b px-2 pt-[calc(var(--safe-area-inset-top,0px)+0.5rem)] pb-2"
  >
    <button
      type="button"
      class="ui-icon-button"
      aria-label={m.reels_publish_back()}
      title={m.reels_publish_back()}
      onclick={() => overlay.dismissFromUi()}
    >
      <ChevronLeft size={24} strokeWidth={2.5} />
    </button>
    <h1 class="text-base font-bold">{m.reels_publish_title()}</h1>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-3">
    <PostIdentityPicker id="reel-identity-select" {associations} bind:value={identity} />

    <div class="mt-4 flex gap-3">
      <!-- The box is 9:16 from the first paint. The take is a local blob, so its first frame is a
           moment away, not a download: until then Canari's own poster fills the box, and the
           element's `poster` is the transparent one - an Android WebView with none draws its own
           grey play glyph over a video that has not decoded yet. -->
      <div
        class="relative aspect-9/16 w-24 shrink-0 overflow-hidden rounded-lg bg-black"
        data-reel-publish-preview
      >
        {#if clip.blob.type.startsWith('image/')}
          <img {src} alt="" class="h-full w-full object-cover" />
        {:else}
          <video
            {src}
            class="h-full w-full object-cover"
            poster={TRANSPARENT_VIDEO_POSTER}
            autoplay
            muted
            loop
            playsinline
            aria-hidden="true"
            onloadeddata={() => (previewReady = true)}
          ></video>
          {#if !previewReady}
            <VideoPoster compact />
          {/if}
        {/if}
      </div>
      <label class="flex min-w-0 flex-1 flex-col">
        <span class="sr-only">{m.reels_publish_caption_label()}</span>
        <textarea
          bind:value={caption}
          rows="5"
          class="text-text-main placeholder:text-text-muted w-full flex-1 resize-none bg-transparent text-base outline-none"
          placeholder={m.reels_publish_caption_placeholder()}
          disabled={publishing}
          data-reel-caption></textarea>
      </label>
    </div>

    {#if clip.soundRemoved}
      <p class="text-text-muted text-2xs mt-4" data-reel-publish-silent>
        {m.reels_review_sound_removed()}
      </p>
    {/if}

    <p class="text-text-muted text-2xs mt-4">
      {m.reels_publish_expiry_note({ days: limits.retentionDays })}
    </p>
  </div>

  <div
    class="border-cn-border bg-cn-surface shrink-0 border-t px-3 pt-2 pb-[calc(var(--safe-area-inset-bottom,0px)+0.5rem)]"
  >
    {#if errorMessage}
      <div
        role="alert"
        class="mb-2 flex items-start gap-2.5 rounded-lg bg-red-500/10 px-3 py-2.5 text-red-600 dark:text-red-400"
      >
        <CircleAlert size={18} strokeWidth={2.5} class="mt-0.5 shrink-0" />
        <span class="flex-1 text-sm leading-snug font-semibold">{errorMessage}</span>
      </div>
    {/if}

    {#if preparation.fraction !== null}
      <VideoPreparationProgress
        fraction={preparation.fraction}
        oncancel={() => preparation.cancel()}
      />
    {/if}

    <div class="flex items-center justify-end gap-3">
      {#if busyLabel}
        <span class="text-text-muted text-sm" aria-live="polite">{busyLabel}</span>
      {/if}
      <Button
        type="button"
        class="shrink-0 px-6 py-2 text-sm font-bold"
        disabled={publishing}
        loading={publishing}
        onclick={publish}
        data-reel-publish-submit
      >
        {m.reels_publish_submit()}
      </Button>
    </div>
  </div>
</div>
