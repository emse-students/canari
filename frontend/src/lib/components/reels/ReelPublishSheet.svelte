<script lang="ts">
  import { resolve } from '$app/paths';
  /**
   * The CanaReels publish step (R3): a caption and the same "who is publishing" choice a post has
   * (`PostIdentityPicker`), over the take it publishes. "Publier" HANDS THE TAKE TO THE PUBLISH
   * QUEUE (`queueReelPublish`, 2026-11-24) and the step is done once it is on the device: the queue
   * re-encodes, uploads in resumable parts and creates the reel, with its line (progress, waiting
   * for the network, a refusal and its Retry, Pause, Delete) in the banner. The member may leave
   * the app: the send resumes where it stopped, and the reel is created once.
   *
   * IT IS A HISTORY ENTRY, so Android's Back (and iOS's edge swipe) returns to the take rather than
   * leaving the camera. The only thing that cannot be interrupted is the write to the device, a
   * moment: a Back then is refused, so a take is never queued twice.
   */
  import { onDestroy, onMount, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import { ChevronLeft, CircleAlert, Clock } from '@lucide/svelte';
  import { goto } from '$app/navigation';
  import PostIdentityPicker from '$lib/components/posts/PostIdentityPicker.svelte';
  import StudentsOnlySwitch from '$lib/components/posts/StudentsOnlySwitch.svelte';
  import { studentsOnlyOffered } from '$lib/posts/studentsOnly';
  import InstitutionReachPicker from '$lib/components/posts/InstitutionReachPicker.svelte';
  import {
    emptyReachDraft,
    institutionReachOffered,
    isReachComplete,
    plainReach,
    type InstitutionReachDraft,
  } from '$lib/posts/institutionReach';
  import type { ComposerReelState } from '$lib/posts/composerReelState';
  import VideoPoster from '$lib/components/shared/VideoPoster.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import type { Association } from '$lib/associations/api';
  import type { ReelLimits } from '$lib/posts/api';
  import { listPostAsAssociations } from '$lib/posts/postIdentity';
  import type { ReelClip } from '$lib/reels/reelCapture';
  import {
    queueReelPublish,
    ReelPublishNoAccountError,
    type PublishReelDeps,
  } from '$lib/reels/publishReel';
  import { enqueuePost } from '$lib/posts/publishQueue/publishQueue.svelte';
  import { currentUserId } from '$lib/stores/userState.svelte';
  import { isQuotaError } from '$lib/db/outboxBlob';
  import {
    longestReelMs,
    reelLifetimeLabel,
    reelRuleNotice,
    reelRuleOf,
  } from '$lib/reels/reelRule';
  import { showToast } from '$lib/stores/toast.svelte';
  import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';
  import { trimComposerText } from '$lib/utils/markdown/composerText';
  import { bindHistoryOverlay } from '$lib/utils/bindHistoryOverlay.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * The step was reached from the new-post composer's camera (user, 2026-10-19: one camera, one
   * behaviour). A member who opened "new post" may not expect a CanaReel, which is DELETED after its
   * lifetime - so the step says so before "Publier" and starts from what the composer held. There is
   * no "keep as a post" any more (owner, 2026-11-09: every vertical video of 90 s or less IS a
   * CanaReel, `reels/reelRule.ts`): a filmed take is one, so handing it back would make it one again.
   */
  interface ReelPublishFromComposer {
    /** The composer's text, identity, "Entre étudiants" and reach: where the step starts. */
    start: ComposerReelState;
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
    /**
     * The take is ALSO sent to conversations (RC-12, 15.5): the outbox's take waiting for THIS
     * publish's upload. Queued, the take's id travels with the post and the QUEUE hands it the file
     * (or ends its wait); left before "Publier", the step ends the wait itself. `onQueued` tells the
     * camera the wait is the queue's now, so its own teardown does not end it.
     */
    chatTake?: {
      id: string;
      endWait: (takeId: string) => void;
      onQueued: () => void;
    } | null;
    /**
     * The step was opened over a CONVERSATION (its camera's "Ajouter des destinataires" with
     * "Publier" ticked, reels-in-chat section 22): once published the camera closes back onto the
     * conversation instead of navigating to the feed.
     */
    onpublishedHere?: () => void;
  }

  let { clip, limits, onclose, deps, composer, chatTake = null, onpublishedHere }: Props = $props();
  /** The rule the server applies (`reelRuleOf`, the version-skew gate), null from an older estate. */
  const rule = $derived(reelRuleOf(limits));

  // Read once: the step starts from the composer and is the member's to change from there.
  let caption = $state(untrack(() => composer?.start.caption ?? ''));
  let identity = $state(untrack(() => composer?.start.identity ?? ''));
  let associations = $state<Association[]>([]);
  /** "Entre étudiants" (owner, 2026-11-04): OFF, offered while an association or a list publishes. */
  let studentsOnly = $state(untrack(() => composer?.start.studentsOnly ?? false));
  const studentsOnlyAssociation = $derived.by(() => {
    const chosen = associations.find((a) => a.id === identity) ?? null;
    return chosen && studentsOnlyOffered(chosen.type) ? chosen : null;
  });
  /** Sent only where offered: a switch left on before the identity changed is not a choice. */
  const sendStudentsOnly = $derived(studentsOnly && studentsOnlyAssociation !== null);
  /**
   * The reach of an institution's post (owner, 2026-11-10): no default, mandatory - "Publier" stays
   * disabled until a space and a public are chosen, and the reach is sent only where it is offered.
   */
  let reach = $state<InstitutionReachDraft>(
    untrack(() => composer?.start.reach ?? emptyReachDraft())
  );
  const reachAssociation = $derived.by(() => {
    const chosen = associations.find((a) => a.id === identity) ?? null;
    return chosen && institutionReachOffered(chosen.type) ? chosen : null;
  });
  const reachMissing = $derived(reachAssociation !== null && !isReachComplete(reach));
  const sendReach = $derived(
    reachAssociation !== null && isReachComplete(reach) ? plainReach(reach) : undefined
  );
  /** The take is being written to the device: a moment, and the one thing a Back cannot stop. */
  let publishing = $state(false);
  /** The take is the queue's: the chat take's wait is the queue's to end, never this step's. */
  let queued = false;
  let errorMessage = $state('');
  /** The preview's first frame is decoded: Canari's poster gives way to it. */
  let previewReady = $state(false);
  /** Where the focus goes when the step opens: the deletion notice first, else the title. */
  let notice = $state<HTMLElement | null>(null);
  let heading = $state<HTMLElement | null>(null);
  const overlay = bindHistoryOverlay(
    () => true,
    (reason) => {
      /*
       * A TAKE BEING WRITTEN TO THE DEVICE KEEPS THE SHEET (review of #2124: closing it under a
       * publish handed the take back to its review, and a second "Publier" published it twice). The
       * write is a moment; once it is done the take is the queue's and the sheet closes by itself.
       */
      if (publishing && reason === 'back') {
        console.debug('[reel-publish] Back refused: the take is being written to the device');
        overlay.clearRef();
        overlay.syncOpen();
        return;
      }
      console.debug('[reel-publish] the sheet was dismissed');
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
    // Left (Back, navigation) without queuing: the take stops waiting and uploads its own. Queued,
    // the wait is the queue's: ending it here would cost the conversations a second upload.
    if (!queued) chatTake?.endWait(chatTake.id);
  });

  /** "Publier": the take and its post are written to the device, and the queue sends them. */
  async function publish() {
    console.debug('[reel-publish] publish pressed');
    publishing = true;
    errorMessage = '';
    caption = trimComposerText(caption);
    try {
      if (studentsOnlyAssociation) {
        console.debug(
          `[reel-publish] publishing with "Entre étudiants" ${sendStudentsOnly ? 'ON' : 'off'}`
        );
      }
      if (reachAssociation) {
        console.debug(
          `[reel-publish] publishing with a reach of ${reach.spaces.length} space(s), public ${reach.public}`
        );
      }
      await queueReelPublish(
        {
          clip,
          caption,
          identity,
          studentsOnly: sendStudentsOnly,
          reach: sendReach,
          maxDurationMs: rule ? longestReelMs(rule) : limits.maxDurationMs,
          ...(chatTake ? { chatTakeId: chatTake.id } : {}),
        },
        deps ?? { userId: currentUserId, enqueue: enqueuePost }
      );
      queued = true;
      chatTake?.onQueued();
      showToast(m.reels_publish_queued(), 'info');
      if (composer) {
        // Over the composer on the feed already: the composer closes, no navigation.
        composer.onpublished(identity);
        return;
      }
      if (onpublishedHere) {
        console.debug('[reel-publish] queued from a conversation camera: back to it');
        onpublishedHere();
        return;
      }
      await goto(resolve('/posts'), { replace: true });
    } catch (err) {
      // ACCUSED: nothing was queued, and the sheet keeps everything for another press.
      console.error('[reel-publish] the take could not be written to the device', err);
      errorMessage =
        err instanceof ReelPublishNoAccountError
          ? m.reels_publish_no_account()
          : isQuotaError(err)
            ? m.publish_queue_enqueue_storage_full()
            : m.reels_publish_enqueue_error();
    } finally {
      publishing = false;
    }
  }
</script>

<div
  class="bg-cn-bg text-text-main absolute inset-0 z-20 flex flex-col pb-(--keyboard-occlusion-bottom,0px)"
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
      disabled={publishing}
      onclick={() => overlay.dismissFromUi()}
    >
      <ChevronLeft size={24} strokeWidth={2.5} />
    </button>
    <h1 bind:this={heading} tabindex="-1" class="font-body text-base font-bold outline-none">
      {m.reels_publish_title()}
    </h1>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-3">
    {#if composer}
      <p
        bind:this={notice}
        role="note"
        tabindex="-1"
        class="bg-amber-warn/10 text-amber-warn-text mb-4 flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold outline-none"
        data-reel-publish-composer-notice
      >
        <Clock size={16} strokeWidth={2.5} class="mt-0.5 shrink-0" />
        <span
          >{rule
            ? reelRuleNotice(rule, limits.retentionDays)
            : m.reels_publish_from_composer_notice({
                seconds: Math.round(limits.maxDurationMs / 1000),
                lifetime: reelLifetimeLabel(limits.retentionDays),
              })}</span
        >
      </p>
    {/if}
    <PostIdentityPicker id="reel-identity-select" {associations} bind:value={identity} />
    {#if studentsOnlyAssociation}
      <div class="mt-3">
        <StudentsOnlySwitch bind:checked={studentsOnly} />
      </div>
    {/if}
    {#if reachAssociation}
      <div class="mt-3">
        <InstitutionReachPicker
          bind:reach
          associationId={reachAssociation.id}
          associationName={reachAssociation.name}
          busy={publishing}
        />
      </div>
    {/if}

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
      {m.reels_publish_expiry_note({ lifetime: reelLifetimeLabel(limits.retentionDays) })}
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

    <div class="flex items-center justify-end gap-3">
      <Button
        type="button"
        class="shrink-0"
        disabled={publishing || reachMissing}
        loading={publishing}
        onclick={publish}
        data-reel-publish-submit
      >
        {m.reels_publish_submit()}
      </Button>
    </div>
  </div>
</div>
