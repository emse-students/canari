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
  import { onDestroy, onMount, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import { ChevronLeft, CircleAlert, Clock } from '@lucide/svelte';
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

  /**
   * The step was reached from the new-post composer's camera (user, 2026-10-19: one camera, one
   * behaviour). A member who opened "new post" may not expect a CanaReel, which is DELETED after its
   * days - so the step says so before "Publier", starts from what the composer held, and offers the
   * old outcome: the video handed back to the composer, kept as an ordinary post.
   */
  interface ReelPublishFromComposer {
    /** The composer's text, the caption's start. */
    caption: string;
    /** The composer's "who is publishing" choice, the picker's start. */
    identity: string;
    /**
     * "Garder comme post": the video goes back to the composer as an attachment, with the caption
     * and identity as the step holds them NOW - an edit made here is the member's, not lost.
     */
    onkeep: (caption: string, identity: string) => void;
    /** The reel was published, as `identity`: the composer closes behind it. */
    onpublished: (identity: string) => void;
  }

  interface Props {
    clip: ReelClip;
    limits: ReelLimits;
    /** Back to the take. */
    onclose: () => void;
    /** Injectable for tests; the real services otherwise. */
    deps?: PublishReelDeps;
    /** Set when the take was filmed from the new-post composer; absent on the CanaReels tab. */
    composer?: ReelPublishFromComposer;
  }

  let { clip, limits, onclose, deps, composer }: Props = $props();

  // Read once: the step starts from the composer and is the member's to change from there.
  let caption = $state(untrack(() => composer?.caption ?? ''));
  let identity = $state(untrack(() => composer?.identity ?? ''));
  let associations = $state<Association[]>([]);
  let publishing = $state(false);
  let stage = $state<PublishStage | null>(null);
  let errorMessage = $state('');
  /** The preview's first frame is decoded: Canari's poster gives way to it. */
  let previewReady = $state(false);
  /** Where the focus goes when the step opens: the deletion notice first, else the title. */
  let notice = $state<HTMLElement | null>(null);
  let heading = $state<HTMLElement | null>(null);
  const preparation = new VideoPreparationState();

  /**
   * The publish can no longer be stopped, so nothing may close the step under it. A VIDEO is
   * stoppable until its upload: the re-encode signal is armed when "Publier" is pressed, and an
   * abort during the mute check or the token makes the re-encode refuse at its first line, so no
   * post is created. A PHOTO has no signal at any stage (`publishCameraPhoto`), so from the press
   * on it is past stopping (re-review of #2124: a Back in its first second gave a second post).
   */
  const uploading = $derived(
    publishing &&
      (clip.blob.type.startsWith('image/') || stage === 'mediaUpload' || stage === 'createPost')
  );

  const overlay = bindHistoryOverlay(
    () => true,
    (reason) => {
      /*
       * A PUBLISH PAST ITS UPLOAD KEEPS THE SHEET (review of #2124). Closing it used to hand the take
       * back to its review while the upload went on, and "Suivant" then "Publier" published the same
       * take a SECOND time. So a Back here is refused and the entry given back: the sheet - whose
       * `publishing` disables "Publier" - stays up until the publish ends. Nothing else can unmount
       * it from under a publish except leaving the screen, which takes the take with it.
       */
      if (uploading && reason === 'back') {
        console.debug(
          `[reel-publish] Back refused: the publish can no longer be stopped (${stage})`
        );
        overlay.clearRef();
        overlay.syncOpen();
        return;
      }
      // Only a publish that has not reached the upload has anything to cancel. Cancelling after it
      // (the landing on the feed closes this sheet too) logged "cancelled by the member" for a reel
      // that had just been published (REEL-2 on the Mi 9T, 2026-10-02).
      const cancellable = publishing && !uploading;
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
    // THE FOCUS MOVES INTO THE STEP, so a screen reader starts here - from the composer, on the
    // notice that the reel is deleted, before anything can be published.
    (notice ?? heading)?.focus();
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
      if (composer) {
        // Over the composer on the feed already: the composer closes, no navigation.
        composer.onpublished(identity);
        return;
      }
      await goto(resolve('/posts'), { replace: true });
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
      disabled={uploading}
      onclick={() => overlay.dismissFromUi()}
    >
      <ChevronLeft size={24} strokeWidth={2.5} />
    </button>
    <h1 bind:this={heading} tabindex="-1" class="text-base font-bold outline-none">
      {m.reels_publish_title()}
    </h1>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-3">
    {#if composer}
      <p
        bind:this={notice}
        role="note"
        tabindex="-1"
        class="bg-amber-warn/10 text-amber-warn mb-4 flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold outline-none"
        data-reel-publish-composer-notice
      >
        <Clock size={16} strokeWidth={2.5} class="mt-0.5 shrink-0" />
        <span>{m.reels_publish_from_composer_notice({ days: limits.retentionDays })}</span>
      </p>
    {/if}
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
      {:else if composer}
        <Button
          type="button"
          variant="outline"
          class="shrink-0 px-4 py-2 text-sm font-semibold"
          disabled={publishing}
          onclick={() => {
            console.debug('[reel-publish] kept as a post: the video goes back to the composer');
            composer.onkeep(caption, identity);
          }}
          data-reel-keep-as-post
        >
          {m.reels_publish_keep_as_post()}
        </Button>
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
