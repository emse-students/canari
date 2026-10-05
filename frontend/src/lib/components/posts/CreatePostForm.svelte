<script lang="ts">
  import { needsThumbIcon } from '$lib/utils/mediaLayout';
  import { Log } from '$lib/utils/Log';
  import { FileText, Film, Music, CalendarCheck, CircleAlert } from '@lucide/svelte';
  import { slide, fade } from 'svelte/transition';
  import { onMount } from 'svelte';
  import { MediaService, preparePostMedia } from '$lib/media';
  import { getToken } from '$lib/stores/auth';
  import { createPost, type CreatePostPayload, type PostFeed } from '$lib/posts/api';
  import { landingFeedFor } from '$lib/posts/landingFeed';
  import { assertNotMuted } from '$lib/moderation/muteCheck';
  import { publishFailureMessage, type PublishStage } from '$lib/posts/publishFailure';
  import { hasContent, localPublishBlocker } from '$lib/posts/composerReadiness';
  import {
    emptyPollOptions,
    filledPollOptions,
    normalizeMaxSelections,
    type PollDraft,
    type PollDraftOption,
    type PollDraftIssue,
  } from '$lib/posts/pollDraft';
  import { LocalizedError } from '$lib/utils/localizedError';
  import { getForms, type Form } from '$lib/forms/api';
  import {
    ANONYMOUS_POST_IDENTITY,
    buildCreateFormHref,
    clearPostComposerDraft,
    emptyPostComposerDraft,
    isPostComposerDraftWorthKeeping,
    loadPostComposerDraft,
    POST_NEW_FORM_ID_KEY,
    savePostComposerDraft,
    withoutAbandonedAttachments,
    type PostComposerDraft,
  } from '$lib/posts/postComposerDraft';
  import {
    listLinkableValidatedCalendarEvents,
    type Association,
    type AssociationCalendarEvent,
  } from '$lib/associations/api';
  import { listPostAsAssociations, postIdentityFields } from '$lib/posts/postIdentity';
  import Picker from '$lib/components/ui/Picker.svelte';
  import PostIdentityPicker from './PostIdentityPicker.svelte';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import PostComposerBar from './PostComposerBar.svelte';
  import MediaThumbRemoveButton from './MediaThumbRemoveButton.svelte';
  import PickedMediaPreview from './PickedMediaPreview.svelte';
  import MediaCaptionChip from './MediaCaptionChip.svelte';
  import MediaCaptionField from './MediaCaptionField.svelte';
  import { shiftAfterRemoval } from './mediaCaptionIndex';
  import { trimComposerText } from '$lib/utils/markdown/composerText';
  import PollSection from './PollSection.svelte';
  import FormSection from './FormSection.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { m } from '$lib/paraglide/messages';
  import { linkableEventPickerOptions } from '$lib/utils/time';
  import { isVideoPrepareError } from '$lib/video/prepareVideoForUpload';
  import { VideoPreparationState } from '$lib/video/videoPreparationState.svelte';
  import VideoPreparationProgress from '$lib/components/shared/VideoPreparationProgress.svelte';

  /**
   * Full-featured post creation form. Supports:
   * - Markdown text with auto-saved draft
   * - Image uploads (encrypted via MediaService)
   * - Poll, event registration button, or standalone form attachment
   * - Scheduled publication
   * - Posting as an association (admin/owner role required)
   */
  interface Props {
    /**
     * Called after the post is successfully created so the parent can refresh its list.
     *
     * `landing` is the feed the new post appears in: `associations` for a post made as an
     * association, `all` for a personal one, `null` for a scheduled one, which no feed shows yet.
     * THE PARENT MUST SHOW IT - a member publishing from the Associations tab used to be returned
     * to a list without their post (reported 2026-10-05, a personal post on the Mi 9T).
     */
    onPostCreated: (landing: PostFeed | null) => void;
  }

  let { onPostCreated }: Props = $props();

  // --- Text & media ---
  let markdown = $state('');
  let selectedFiles = $state<File[]>([]);
  let filePreviews = $state<string[]>([]);
  let fileThumbIcons = $state<boolean[]>([]);
  let mediaCaptions = $state<string[]>([]);

  // --- Optional sections ---
  let includePoll = $state(false);
  let pollQuestion = $state('');
  let pollOptions = $state<PollDraftOption[]>(emptyPollOptions());
  let pollMultipleChoice = $state(false);
  let pollMaxSelections = $state<number | null>(null);
  let pollEndsAt = $state('');
  let pollAnonymous = $state(false);
  /** Which poll field the last refused publish was waiting on, shown inside the card. */
  let pollIssue = $state<PollDraftIssue | null>(null);

  /** The poll as the rules in `pollDraft.ts` want it, or `null` when the toggle is off. */
  const pollDraft = $derived<PollDraft | null>(
    includePoll
      ? {
          question: pollQuestion,
          options: pollOptions,
          multipleChoice: pollMultipleChoice,
          maxSelections: pollMaxSelections,
          endsAt: pollEndsAt,
        }
      : null
  );

  let includeForm = $state(false);
  let selectedFormId = $state('');
  let availableForms = $state<Form[]>([]);

  // --- Scheduled publication ---
  let scheduledAt = $state('');

  // --- Association identity ---
  /** Associations the user may post as (`listPostAsAssociations`). */
  let postAsAssociations = $state<Association[]>([]);
  /** Who is publishing - `''`, anonymous or an association (`PostIdentityPicker`). */
  let selectedAssociationId = $state('');
  let selectedLinkedCalendarEventId = $state('');
  let linkableCalendarEvents = $state<AssociationCalendarEvent[]>([]);
  let loadingLinkableEvents = $state(false);

  const isAnonymousSelected = $derived(selectedAssociationId === ANONYMOUS_POST_IDENTITY);
  const isAssociationSelected = $derived(!!selectedAssociationId && !isAnonymousSelected);

  /** The events a post as an association may link to, "no event" first. */
  const linkableEventOptions = $derived(
    linkableEventPickerOptions(linkableCalendarEvents, loadingLinkableEvents)
  );

  let editorField = $state<MarkdownComposerField | null>(null);
  /** Which picked file's caption field is open under the strip - at most one (`MediaCaptionChip`). */
  let captionIndex = $state<number | null>(null);

  // --- UI state ---
  let publishing = $state(false);
  let errorMessage = $state('');
  /** A picked video being re-encoded on the device during publish (decision C3). */
  const videoPreparation = new VideoPreparationState();
  let authToken = $state('');
  // --- Draft auto-save (full composer state; images are not persisted) ---
  let draftRestored = $state(false);
  let draftSaved = $state(false);
  let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;

  function snapshotComposerDraft(): PostComposerDraft {
    return {
      version: 1,
      markdown,
      imageCaptions: [...mediaCaptions],
      includePoll,
      pollQuestion,
      pollOptions: [...pollOptions],
      pollMultipleChoice,
      pollMaxSelections,
      pollEndsAt,
      includeForm,
      selectedFormId,
      scheduledAt,
      selectedAssociationId,
      selectedLinkedCalendarEventId,
    };
  }

  function applyComposerDraft(draft: PostComposerDraft) {
    markdown = draft.markdown;
    mediaCaptions = draft.imageCaptions ?? [];
    includePoll = draft.includePoll;
    pollQuestion = draft.pollQuestion;
    pollOptions = [...draft.pollOptions];
    pollMultipleChoice = draft.pollMultipleChoice;
    pollMaxSelections = draft.pollMaxSelections;
    pollEndsAt = draft.pollEndsAt;
    pollIssue = null;
    includeForm = draft.includeForm;
    selectedFormId = draft.selectedFormId;
    scheduledAt = draft.scheduledAt;
    selectedAssociationId = draft.selectedAssociationId;
    selectedLinkedCalendarEventId = draft.selectedLinkedCalendarEventId;
  }

  function persistComposerDraft() {
    savePostComposerDraft(snapshotComposerDraft());
  }

  /** Debounced draft save after any composer field changes. */
  $effect(() => {
    void snapshotComposerDraft();
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    let feedbackTimer: ReturnType<typeof setTimeout> | null = null;
    draftSaveTimer = setTimeout(() => {
      const snap = snapshotComposerDraft();
      if (isPostComposerDraftWorthKeeping(withoutAbandonedAttachments(snap))) {
        savePostComposerDraft(snap);
        draftSaved = true;
        feedbackTimer = setTimeout(() => {
          draftSaved = false;
        }, 1800);
      } else {
        clearPostComposerDraft();
      }
    }, 800);
    // Clear both timers on re-run or component destruction.
    return () => {
      if (draftSaveTimer) clearTimeout(draftSaveTimer);
      if (feedbackTimer) clearTimeout(feedbackTimer);
    };
  });

  /*
   * THE ERROR BANNER USED TO ERASE ITSELF AFTER 5 SECONDS, AND THAT IS WHY A REPORT ARRIVED WITH
   * NO SENTENCE IN IT.
   *
   * A timer decided when the reader had finished reading. On a phone the on-screen keyboard can
   * still be covering the banner when it goes, and what is left is a composer that does not
   * publish and says nothing at all - which is exactly how the 2026-09-21 report reached us: a
   * member who could only say "sans succes". Ask of any timer what it would mean if it were wrong;
   * the answer here was "the one line that names the cause is gone".
   *
   * So it is cleared by the reader or by the facts, never by a clock: `publishPost` resets it on
   * the next attempt, a successful publish resets the whole form, and the banner carries its own
   * dismiss button. The condition it describes is still true until one of those happens, and a
   * message that outlives its cause would be the opposite defect - which is why nothing else
   * clears it.
   */

  /** Load validated agenda events when posting as an association. */
  $effect(() => {
    const assoId = selectedAssociationId;
    selectedLinkedCalendarEventId = '';
    linkableCalendarEvents = [];
    if (!assoId || assoId === ANONYMOUS_POST_IDENTITY) return;
    loadingLinkableEvents = true;
    listLinkableValidatedCalendarEvents(assoId)
      .then((rows) => {
        linkableCalendarEvents = rows;
      })
      .catch((e) => {
        console.error('Failed to load linkable calendar events', e);
      })
      .finally(() => {
        loadingLinkableEvents = false;
      });
  });

  const mediaService = new MediaService();

  onMount(async () => {
    const saved = loadPostComposerDraft();
    if (saved) {
      applyComposerDraft(saved);
      draftRestored = true;
    }

    try {
      authToken = await getToken();
    } catch {
      /* retried on upload */
    }
    try {
      availableForms = await getForms();
    } catch (e) {
      console.error('Failed to load forms', e);
    }

    const newFormId = sessionStorage.getItem(POST_NEW_FORM_ID_KEY);
    if (newFormId) {
      sessionStorage.removeItem(POST_NEW_FORM_ID_KEY);
      try {
        availableForms = await getForms();
      } catch {
        /* keep previous list */
      }
      includeForm = true;
      selectedFormId = newFormId;
    }

    try {
      postAsAssociations = await listPostAsAssociations();
    } catch (e) {
      console.error('Failed to load associations', e);
    }
  });

  /**
   * Adds media to the selection, KEEPING what is already there - from a picker, the camera, a drop
   * or a paste alike.
   *
   * A pick used to REPLACE the selection, because an `<input type="file">` hands over its entire
   * selection on every change and appending would have duplicated it. Since the composer has four
   * inputs (photos, camera, video, documents - `PostComposerBar`) a replacing pick would throw away
   * the photo taken a moment ago the instant a PDF was added, so every input now empties itself
   * after each pick and hands over only what was just chosen. From here on a dropped file is
   * indistinguishable from a picked one, which is what was asked (user, 2026-09-18: *"Que glisser
   * deposer ajoute le media au post (comme si on cliquait sur Medias -> Envoi du fichier)"*).
   */
  function addFiles(files: File[]) {
    if (files.length === 0) return;
    selectedFiles = [...selectedFiles, ...files];
    filePreviews = [
      ...filePreviews,
      ...files.map((f) => (needsThumbIcon(f) ? '' : URL.createObjectURL(f))),
    ];
    fileThumbIcons = [...fileThumbIcons, ...files.map((f) => needsThumbIcon(f))];
    mediaCaptions = [...mediaCaptions, ...files.map(() => '')];
    Log.d('POST_COMPOSER', `${files.length} media added, ${selectedFiles.length} total`);
  }

  /** Remove a single media file from the selection by index. */
  function removeFile(i: number) {
    if (filePreviews[i]) URL.revokeObjectURL(filePreviews[i]);
    selectedFiles = selectedFiles.filter((_, idx) => idx !== i);
    filePreviews = filePreviews.filter((_, idx) => idx !== i);
    fileThumbIcons = fileThumbIcons.filter((_, idx) => idx !== i);
    mediaCaptions = mediaCaptions.filter((_, idx) => idx !== i);
    captionIndex = shiftAfterRemoval(captionIndex, i);
  }

  /** Icon matching the media type for generic file previews. */
  function fileTypeIcon(file: File) {
    if (file.type.startsWith('video/')) return Film;
    if (file.type.startsWith('audio/')) return Music;
    return FileText;
  }

  /**
   * Upload images, assemble the payload, call createPost, then reset the form.
   *
   * EVERY REFUSAL BELOW SAYS WHICH ONE IT IS, and none of them did until 2026-09-21. Five throws
   * already carried their own translated sentence and one `catch` replaced all five with "could not
   * publish the post" - which is the whole of what a member on a phone was able to report. Nothing
   * on the server could add to it: no `POST /api/posts` reached nginx in the hour, and
   * `social-service` logged nothing, because the failure never left the device.
   *
   * So the sentences are typed at the throw (`LocalizedError`, `MutedError`) and `stage` records
   * how far this got, for the console. See `posts/publishFailure.ts`.
   *
   * AND NOTHING LOCAL IS LEARNED BY FAILING ANY MORE. The three preconditions this composer can
   * answer out of its own `$state` are settled FIRST, before `assertNotMuted()` puts a round trip
   * in front of them - see `posts/composerReadiness.ts` for the report that named it.
   */
  async function publishPost() {
    Log.d('POST_COMPOSER', 'publishPost');
    publishing = true;
    errorMessage = '';
    markdown = trimComposerText(markdown);

    // Reassigned in front of each step rather than derived afterwards: `catch` cannot see where it
    // came from, and the two causes that keep the declared fallback are exactly the two the reader
    // cannot tell apart without it.
    let stage: PublishStage = 'content';
    try {
      // Everything answerable here, answered here: the refusal is instant and costs no request.
      const blocker = localPublishBlocker({
        markdown,
        fileCount: selectedFiles.length,
        poll: pollDraft,
        form: includeForm ? { selectedFormId, availableCount: availableForms.length } : null,
      });
      pollIssue = blocker?.pollIssue ?? null;
      if (blocker) {
        stage = blocker.stage;
        throw new LocalizedError(blocker.message);
      }

      stage = 'moderation';
      await assertNotMuted();
      stage = 'mediaToken';
      if (selectedFiles.length > 0 && !authToken) {
        try {
          authToken = await getToken();
        } catch {
          throw new LocalizedError(m.post_create_image_token_error());
        }
      }

      // Compress images, re-encode videos on the device, upload the rest as-is; collect the refs.
      const media = [];
      const limits = selectedFiles.length > 0 ? await mediaService.uploadLimits() : null;
      for (let i = 0; i < selectedFiles.length; i++) {
        stage = 'mediaPrepare';
        const { file, dims } = await preparePostMedia(
          selectedFiles[i],
          videoPreparation.optionsFor(limits?.maxPlaintextBytes)
        );
        videoPreparation.finish();
        stage = 'mediaUpload';
        const ref = await mediaService.encryptAndUpload(file, authToken, dims, 'archive');
        const caption = mediaCaptions[i]?.trim();
        media.push({ ...ref, ...(caption ? { caption } : {}) });
      }

      const payload: CreatePostPayload = {
        markdown,
        media,
        ...(scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
      };

      // Both attachments were validated above, so assembly only reads them - and it reads the
      // options through the SAME parser that counted them, never a second spelling of the rule.
      if (includePoll) {
        const options = filledPollOptions(pollOptions);
        payload.polls = [
          {
            question: pollQuestion.trim(),
            options,
            multipleChoice: pollMultipleChoice,
            maxSelections: normalizeMaxSelections(
              pollMaxSelections,
              options.length,
              pollMultipleChoice
            ),
            ...(pollEndsAt ? { endsAt: new Date(pollEndsAt).toISOString() } : {}),
            ...(pollAnonymous ? { anonymous: true } : {}),
          },
        ];
      }
      if (includeForm) payload.attachedFormId = selectedFormId;

      Object.assign(payload, postIdentityFields(selectedAssociationId));
      if (selectedLinkedCalendarEventId.trim()) {
        payload.linkedCalendarEventId = selectedLinkedCalendarEventId.trim();
      }
      stage = 'createPost';
      // Read BEFORE the reset below: the form forgets who it posted as.
      const landing = landingFeedFor({
        asAssociation: !!selectedAssociationId,
        scheduled: !!scheduledAt,
      });
      await createPost(payload);

      // Reset all state after successful creation
      clearPostComposerDraft();
      draftRestored = false;
      markdown = '';
      filePreviews.forEach((url) => URL.revokeObjectURL(url));
      selectedFiles = [];
      filePreviews = [];
      fileThumbIcons = [];
      mediaCaptions = [];
      captionIndex = null;
      includePoll = false;
      pollQuestion = '';
      pollOptions = emptyPollOptions();
      pollMaxSelections = null;
      pollEndsAt = '';
      pollIssue = null;
      includeForm = false;
      scheduledAt = '';
      selectedAssociationId = '';
      selectedLinkedCalendarEventId = '';
      onPostCreated(landing);
    } catch (err) {
      if (isVideoPrepareError(err) && err.fault === 'aborted') {
        // The member pressed the cross on the progress line: the composer stays as it was.
        Log.d('POST_COMPOSER', 'publish stopped: video preparation cancelled');
        return;
      }
      // ACCUSED IN THE CONSOLE, EXPLAINED ON SCREEN. This was `Log.d` - debug level - in a file
      // that already logged `console.error` for a dropdown that would not load, so the one failure
      // a reader reports was the quietest line in it.
      console.error(`[POST_COMPOSER] publish failed at ${stage}`, err);
      errorMessage = publishFailureMessage(err, m.post_create_publish_error());
    } finally {
      videoPreparation.finish();
      publishing = false;
    }
  }
</script>

<!--
  ONE COLUMN: a scroll region, and a footer that is never scrolled away.

  Inside `Modal`'s `phoneFullScreen` the panel fills the space above the keyboard, so the footer -
  attachments, formatting and "Publier" - sits on the keyboard while the text scrolls above it. That
  is the layout the user asked for after comparing with Facebook's composer on the Mi 9T
  (2026-09-29): the author as one line, the text taking the height, the actions under the thumb.
  The error banner is in the FOOTER for the reason its comment in the script gives: a keyboard used
  to cover the one sentence that named the cause.
-->
<div class="flex min-h-0 flex-1 flex-col">
  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-3 sm:px-6">
    <!-- Who is publishing: the avatar of that identity, and the choice itself drawn as the name. -->
    <PostIdentityPicker
      id="post-association-select"
      associations={postAsAssociations}
      bind:value={selectedAssociationId}
    />

    {#if isAssociationSelected}
      <div class="mt-3" transition:fade={{ duration: 200 }}>
        <label
          for="post-linked-calendar-event"
          class="text-text-muted text-2xs mb-1 flex items-center gap-1.5 font-semibold"
        >
          <CalendarCheck size={14} strokeWidth={2.5} class="text-amber-500" />
          {m.post_create_link_event_label()}
        </label>
        <Picker
          id="post-linked-calendar-event"
          value={selectedLinkedCalendarEventId}
          options={linkableEventOptions}
          onValueChange={(v) => (selectedLinkedCalendarEventId = v)}
          label={m.post_create_link_event_label()}
          disabled={loadingLinkableEvents}
          variant="field"
        />
      </div>
    {/if}

    {#if draftRestored}
      <div
        class="mt-3 flex items-center justify-between gap-3 rounded-lg bg-amber-500/10 px-3 py-2"
        transition:slide={{ duration: 200 }}
      >
        <span class="text-2xs font-semibold text-amber-700 dark:text-amber-400">
          {m.post_create_draft_restored_label()}
          <span class="font-medium opacity-70">{m.post_create_draft_restored_detail()}</span>
        </span>
        <button
          type="button"
          onclick={() => {
            applyComposerDraft(emptyPostComposerDraft());
            clearPostComposerDraft();
            draftRestored = false;
          }}
          class="text-2xs shrink-0 font-bold text-amber-700 outline-none hover:underline focus-visible:underline dark:text-amber-400"
        >
          {m.post_create_clear_draft_label()}
        </button>
      </div>
    {/if}

    <MarkdownComposerField
      bind:this={editorField}
      bind:value={markdown}
      onmedia={addFiles}
      showToolbar={false}
      placeholder={m.post_create_message_placeholder()}
      minHeight={selectedFiles.length > 0 ? '3rem' : '10rem'}
      class="mt-2 w-full min-w-0"
      editorClass="w-full max-w-full bg-transparent px-1 py-2 text-base leading-relaxed text-text-main"
    />

    {#if selectedFiles.length > 0}
      <div
        class="-mx-1 flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-1 pt-1 pb-2"
        transition:slide={{ duration: 200 }}
        role="list"
      >
        {#each selectedFiles as file, i (file.name + i)}
          {@const Icon = fileTypeIcon(file)}
          <div class="flex w-28 shrink-0 snap-start flex-col gap-1.5" role="listitem">
            <div
              class="border-cn-border relative aspect-square w-full overflow-hidden rounded-lg border"
            >
              {#if fileThumbIcons[i]}
                <div
                  class="text-text-muted flex h-full w-full flex-col items-center justify-center gap-1.5 bg-black/5 dark:bg-white/5"
                >
                  <Icon size={28} strokeWidth={1.5} />
                  <span
                    class="text-2xs w-full truncate px-2 text-center font-bold tracking-wider uppercase"
                  >
                    {file.type.split('/')[1] ?? 'file'}
                  </span>
                </div>
              {:else}
                <PickedMediaPreview
                  {file}
                  src={filePreviews[i]}
                  alt={file.type.startsWith('image/')
                    ? m.post_create_image_preview_alt()
                    : m.post_create_media_preview_alt()}
                />
              {/if}
              <MediaThumbRemoveButton
                label={m.post_create_remove_image_label()}
                title={m.common_delete_button()}
                onclick={() => removeFile(i)}
              />
              <MediaCaptionChip
                hasCaption={!!mediaCaptions[i]?.trim()}
                active={captionIndex === i}
                onclick={() => (captionIndex = captionIndex === i ? null : i)}
              />
            </div>
          </div>
        {/each}
      </div>
      {#if captionIndex !== null && captionIndex < selectedFiles.length}
        {#key captionIndex}
          <MediaCaptionField
            bind:value={mediaCaptions[captionIndex]}
            position={captionIndex + 1}
            onDone={() => (captionIndex = null)}
          />
        {/key}
      {/if}
    {/if}

    {#if includePoll}
      <div class="mt-3" transition:slide={{ duration: 250 }}>
        <PollSection
          bind:question={pollQuestion}
          bind:options={pollOptions}
          bind:multipleChoice={pollMultipleChoice}
          bind:maxSelections={pollMaxSelections}
          bind:endsAt={pollEndsAt}
          bind:anonymous={pollAnonymous}
          issue={pollIssue}
          onRemove={() => {
            includePoll = false;
            pollIssue = null;
          }}
        />
      </div>
    {/if}

    {#if includeForm}
      <div class="mt-3" transition:slide={{ duration: 250 }}>
        <FormSection
          bind:selectedFormId
          {availableForms}
          createFormHref={buildCreateFormHref()}
          onBeforeCreateForm={persistComposerDraft}
          onRemove={() => (includeForm = false)}
        />
      </div>
    {/if}
  </div>

  <div class="border-cn-border bg-cn-surface shrink-0 border-t px-3 pt-2 pb-2 sm:px-5 sm:pb-4">
    {#if errorMessage}
      <div
        transition:slide={{ duration: 200 }}
        role="alert"
        class="mb-2 flex items-start gap-2.5 rounded-lg bg-red-500/10 px-3 py-2.5 text-red-600 dark:text-red-400"
      >
        <CircleAlert size={18} strokeWidth={2.5} class="mt-0.5 shrink-0" />
        <span class="flex-1 text-sm leading-snug font-semibold">{errorMessage}</span>
        <button
          type="button"
          onclick={() => (errorMessage = '')}
          class="shrink-0 text-xs font-bold outline-none hover:underline focus-visible:underline"
        >
          {m.post_create_error_dismiss_label()}
        </button>
      </div>
    {/if}

    {#if videoPreparation.fraction !== null}
      <VideoPreparationProgress
        fraction={videoPreparation.fraction}
        oncancel={() => videoPreparation.cancel()}
      />
    {/if}

    <PostComposerBar
      onFiles={addFiles}
      onFormat={(type) => editorField?.format(type)}
      pollActive={includePoll}
      onTogglePoll={() => (includePoll = !includePoll)}
      formActive={includeForm}
      onToggleForm={() => (includeForm = !includeForm)}
      bind:scheduledAt
      status={draftSaved ? m.post_create_draft_saved_label() : ''}
    >
      {#snippet action()}
        <Button
          type="button"
          class="shrink-0 px-5 py-2 text-sm font-bold!"
          disabled={publishing || !hasContent(markdown, selectedFiles.length)}
          loading={publishing}
          onclick={publishPost}
        >
          {#if publishing}
            {scheduledAt
              ? m.post_create_scheduling_in_progress_label()
              : m.post_create_publishing_in_progress_label()}
          {:else}
            {scheduledAt
              ? m.post_create_schedule_button_label()
              : m.post_create_publish_button_label()}
          {/if}
        </Button>
      {/snippet}
    </PostComposerBar>
  </div>
</div>
