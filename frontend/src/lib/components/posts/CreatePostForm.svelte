<script lang="ts">
  import { needsThumbIcon } from '$lib/utils/mediaLayout';
  import { Log } from '$lib/utils/Log';
  import { showToast } from '$lib/stores/toast.svelte';
  import {
    POST_ATTACHMENTS_MAX,
    admitAttachments,
    attachmentCapNotice,
  } from '$lib/posts/attachmentCap';
  import { FileText, Film, Music, CalendarCheck, CircleAlert, CloudUpload } from '@lucide/svelte';
  import { slide, fade } from 'svelte/transition';
  import { onDestroy, onMount } from 'svelte';
  import type { CreatePostPayload, PostFeed } from '$lib/posts/api';
  import { landingFeedFor } from '$lib/posts/landingFeed';
  import { publishFailureMessage, type PublishStage } from '$lib/posts/publishFailure';
  import { enqueuePost } from '$lib/posts/publishQueue/publishQueue.svelte';
  import { isQuotaError } from '$lib/db/outboxBlob';
  import { currentUserId } from '$lib/stores/userState.svelte';
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
  // A post cannot carry a DRAFT form (the server refuses it): the picker never offers one.
  import { publishedForms } from '$lib/forms/publish';
  import {
    ANONYMOUS_POST_IDENTITY,
    buildCreateFormHref,
    clearPostComposerDraft,
    composerAllowsReel,
    emptyPostComposerDraft,
    heldPostComposerMedia,
    holdPostComposerMedia,
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
  import {
    isAssociationIdentity,
    listLiveAssociations,
    listPostAsAssociations,
    postIdentityFields,
  } from '$lib/posts/postIdentity';
  import Picker from '$lib/components/ui/Picker.svelte';
  import PostIdentityPicker from './PostIdentityPicker.svelte';
  import StudentsOnlySwitch from './StudentsOnlySwitch.svelte';
  import { studentsOnlyOffered } from '$lib/posts/studentsOnly';
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
  import { composerDropZone } from '$lib/utils/composerDropZone';
  import { linkableEventPickerOptions } from '$lib/utils/time';
  import { livesAvailable } from '$lib/utils/livesAvailability';
  import { serverLivesMode } from '$lib/stores/appVersionCheck.svelte';

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
    /**
     * The member chose "En direct". The PARENT closes this composer and hosts the broadcaster's
     * screen, so the live REPLACES the composer instead of stacking on it, and ending it returns to
     * the feed (owner, 2026-10-31). Called after the draft was saved (`goLive`).
     */
    onGoLive: (target: { associationId: string | null; associationName: string | null }) => void;
  }

  let { onPostCreated, onGoLive }: Props = $props();

  // --- Text & media ---
  let markdown = $state('');
  /**
   * The media this composer held when it was last closed (`holdPostComposerMedia`), read before
   * anything else runs so the hold below never sees an empty list first and forgets them.
   */
  // A held list over the cap (a composer from before it) is trimmed here, through the same rule as
  // every other way in, and says so once the composer is mounted.
  const restoredAdmission = admitAttachments(0, heldPostComposerMedia());
  const restoredMedia = restoredAdmission.accepted;
  const restoredCapNotice = attachmentCapNotice(restoredAdmission);
  onMount(() => {
    if (restoredCapNotice) showToast(restoredCapNotice);
  });
  if (restoredMedia.length > 0) {
    Log.d('POST_COMPOSER', `${restoredMedia.length} media kept from the last close - restored`);
  }
  let selectedFiles = $state<File[]>(restoredMedia);
  let filePreviews = $state<string[]>(
    restoredMedia.map((f) => (needsThumbIcon(f) ? '' : URL.createObjectURL(f)))
  );
  let fileThumbIcons = $state<boolean[]>(restoredMedia.map((f) => needsThumbIcon(f)));
  let mediaCaptions = $state<string[]>(restoredMedia.map(() => ''));
  /** Closing the composer keeps its media for the next open, as the text draft keeps its text. */
  $effect(() => {
    holdPostComposerMedia(selectedFiles);
  });
  // The FILES are held, never their previews: each open makes its own object URLs, and gives them
  // back when it closes, or every close would leak one URL per held media.
  onDestroy(() => {
    filePreviews.forEach((url) => url && URL.revokeObjectURL(url));
  });

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
  /** Ids of the associations a live may be started as (`listLiveAssociations`), a subset of the above. */
  let liveAssociationIds = $state<ReadonlySet<string>>(new Set());
  /** Who is publishing - `''`, anonymous or an association (`PostIdentityPicker`). */
  let selectedAssociationId = $state('');
  let selectedLinkedCalendarEventId = $state('');
  let linkableCalendarEvents = $state<AssociationCalendarEvent[]>([]);
  let loadingLinkableEvents = $state(false);

  const isAnonymousSelected = $derived(selectedAssociationId === ANONYMOUS_POST_IDENTITY);
  const isAssociationSelected = $derived(!!selectedAssociationId && !isAnonymousSelected);

  /**
   * The broadcaster's screen is open (WP-L5; the chip is offered only where `livesAvailable` says so -
   * a `LIVE_ENABLED` build AND the server's lives kill switch on). A live goes out under the
   * identity chosen above - the member, or an association they may post as - and never anonymously,
   * so the chip is not offered while "anonymous" is chosen, nor while the chosen association is not
   * in the list read (a restored draft's): the live would otherwise go out under the wrong name.
   */
  const chosenAssociation = $derived(
    isAssociationSelected
      ? (postAsAssociations.find((a) => a.id === selectedAssociationId) ?? null)
      : null
  );
  /**
   * The chosen association, only where the SERVER's live start would accept it
   * (`listLiveAssociations`): a global admin posts as any association but may not broadcast as one
   * they hold no `POST_AS_ASSO` in, and `POST /api/lives` answers `403 LIVE_ASSOCIATION_FORBIDDEN`.
   */
  const liveAssociation = $derived(
    chosenAssociation && liveAssociationIds.has(chosenAssociation.id) ? chosenAssociation : null
  );

  /**
   * "Entre étudiants" (owner, 2026-11-04): OFF by default, offered only while the identity chosen is
   * an association or a list the member may post as - the same entity read as `chosenAssociation`, so
   * a restored draft naming an association no longer listed offers nothing and sends nothing.
   */
  let studentsOnly = $state(false);
  const studentsOnlyAssociation = $derived(
    chosenAssociation && studentsOnlyOffered(chosenAssociation.type) ? chosenAssociation : null
  );

  /**
   * Hands over to the broadcaster's screen. The composer is about to unmount, and the debounced
   * auto-save below dies with it, so the draft is saved NOW (text, poll, form; the media are held
   * in memory by `holdPostComposerMedia`): the next open of the composer brings it back, and
   * nothing is lost silently.
   */
  function goLive() {
    const kept = saveOrClearComposerDraft();
    Log.d(
      'POST_COMPOSER',
      `going live: the composer closes, its draft is ${kept ? 'kept for the next open' : 'empty, nothing to keep'}`
    );
    onGoLive({
      associationId: liveAssociation?.id ?? null,
      associationName: liveAssociation?.name ?? null,
    });
  }

  /** The events a post as an association may link to, "no event" first. */
  const linkableEventOptions = $derived(
    linkableEventPickerOptions(linkableCalendarEvents, loadingLinkableEvents)
  );

  let editorField = $state<MarkdownComposerField | null>(null);
  /** True while a file, image or link is dragged over the sheet; draws the drop overlay. */
  let dropActive = $state(false);
  /** Which picked file's caption field is open under the strip - at most one (`MediaCaptionChip`). */
  let captionIndex = $state<number | null>(null);

  // --- UI state ---
  let publishing = $state(false);
  let errorMessage = $state('');
  /** A picked video being re-encoded on the device during publish (decision C3). */
  // --- Draft auto-save (full composer state; media are held in memory only) ---
  let draftRestored = $state(restoredMedia.length > 0);
  /** The restored draft brought media back (`holdPostComposerMedia`): the banner says so. */
  let draftRestoredMedia = $state(restoredMedia.length > 0);
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
      ...(studentsOnly ? { studentsOnly: true } : {}),
    };
  }

  function applyComposerDraft(draft: PostComposerDraft) {
    markdown = draft.markdown;
    // One caption per media held: a caption saved for a media that is no longer here is dropped,
    // or the next media added would take it.
    mediaCaptions = selectedFiles.map((_, i) => draft.imageCaptions?.[i] ?? '');
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
    studentsOnly = draft.studentsOnly === true;
  }

  function persistComposerDraft() {
    savePostComposerDraft(snapshotComposerDraft());
  }

  /** Saves the composer as it is now, or forgets the draft when nothing in it is worth keeping. */
  function saveOrClearComposerDraft(): boolean {
    const snap = snapshotComposerDraft();
    if (isPostComposerDraftWorthKeeping(withoutAbandonedAttachments(snap))) {
      savePostComposerDraft(snap);
      return true;
    }
    clearPostComposerDraft();
    return false;
  }

  /** Debounced draft save after any composer field changes. */
  $effect(() => {
    void snapshotComposerDraft();
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    let feedbackTimer: ReturnType<typeof setTimeout> | null = null;
    draftSaveTimer = setTimeout(() => {
      if (saveOrClearComposerDraft()) {
        draftSaved = true;
        feedbackTimer = setTimeout(() => {
          draftSaved = false;
        }, 1800);
      }
    }, 800);
    // Clear both timers on re-run or component destruction.
    return () => {
      if (draftSaveTimer) clearTimeout(draftSaveTimer);
      if (feedbackTimer) clearTimeout(feedbackTimer);
    };
  });

  /**
   * A video filmed with this composer's camera was published as a CanaReel (one camera, one
   * behaviour, user 2026-10-19). Its caption WAS this text, so the text goes - and the draft is
   * saved now, not by the debounce the closing composer would cancel, or the next open would bring
   * back a caption already published. Whatever else was here (media, poll, form) stays as the draft.
   */
  /**
   * WHETHER A VIDEO FILMED HERE MAY BECOME A CANAREEL. A reel carries no schedule, poll, form or
   * linked event (the server refuses each on a reel, `assertCreateKindShape`), so a composer the
   * member has set one of them on keeps the camera's old outcome: the video is attached to THIS
   * post, which can honour them (review of #2124). Read when the camera opens, as the chips stand.
   */
  const reelAllowed = $derived(
    composerAllowsReel({
      scheduledAt,
      includePoll,
      includeForm,
      linkedCalendarEventId: selectedLinkedCalendarEventId,
    })
  );

  function onReelPublished(identity: string) {
    Log.d('POST_COMPOSER', 'a reel filmed from this composer was published: its text is spent');
    markdown = '';
    saveOrClearComposerDraft();
    onPostCreated(
      landingFeedFor({ asAssociation: isAssociationIdentity(identity), scheduled: false })
    );
  }

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

  onMount(async () => {
    const saved = loadPostComposerDraft();
    if (saved) {
      applyComposerDraft(saved);
      draftRestored = true;
    }

    try {
      availableForms = publishedForms(await getForms());
    } catch (e) {
      console.error('Failed to load forms', e);
    }

    const newFormId = sessionStorage.getItem(POST_NEW_FORM_ID_KEY);
    if (newFormId) {
      sessionStorage.removeItem(POST_NEW_FORM_ID_KEY);
      try {
        availableForms = publishedForms(await getForms());
      } catch {
        /* keep previous list */
      }
      includeForm = true;
      selectedFormId = newFormId;
    }

    try {
      postAsAssociations = await listPostAsAssociations();
      liveAssociationIds = new Set((await listLiveAssociations()).map((a) => a.id));
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
  function addFiles(incoming: File[]) {
    if (incoming.length === 0) return;
    // At most ten attachments a post: as many as fit are taken, the rest are said out loud.
    const admitted = admitAttachments(selectedFiles.length, incoming);
    const notice = attachmentCapNotice(admitted);
    if (notice) showToast(notice);
    const files = admitted.accepted;
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
   * Hands the post to the BACKGROUND PUBLISH QUEUE and closes (owner, 2026-11-06: the composer
   * closes at once, the send goes on with a discreet progress line, like Facebook). The media are
   * prepared, uploaded one at a time in resumable parts, and the post created by the queue
   * (`posts/publishQueue/publishQueue.ts`), which keeps it on the device until the server holds it.
   *
   * EVERY REFUSAL THIS COMPOSER CAN ANSWER OUT OF ITS OWN STATE IS ANSWERED HERE, before anything is
   * queued, and says which one it is (`composerReadiness.ts`, `publishFailure.ts`): an empty post, a
   * poll with no options, a form not chosen, too many attachments. What only the server or the
   * device can answer - moderation, a video that cannot be prepared, a refused upload - is the
   * queue's, and its line says it with a Retry.
   *
   * THE COMPOSER CLOSES ONLY ONCE THE POST IS ON THE DEVICE: `enqueuePost` resolves after the post
   * and every file are written in one transaction. A write that fails (a full disk) keeps the
   * composer and everything in it, and says why.
   */
  async function publishPost() {
    Log.d('POST_COMPOSER', 'publishPost');
    publishing = true;
    errorMessage = '';
    markdown = trimComposerText(markdown);

    // Reassigned in front of each step, so the console line names where a refusal came from.
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
      // The server would refuse a post over the cap after every blob was sent. The composer stops
      // adding at the cap, so this is a net, never a path.
      if (selectedFiles.length > POST_ATTACHMENTS_MAX) {
        throw new LocalizedError(m.post_attachments_too_many({ max: POST_ATTACHMENTS_MAX }));
      }
      const userId = currentUserId();
      if (!userId) throw new LocalizedError(m.post_create_publish_error());

      const payload: Omit<CreatePostPayload, 'media' | 'images'> = {
        markdown,
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
      // Sent only where it is offered: a switch left on before the identity changed is not a choice.
      if (studentsOnly && studentsOnlyAssociation) payload.studentsOnly = true;
      if (studentsOnlyAssociation) {
        Log.d('STUDENTS_ONLY', `publishing with the switch ${payload.studentsOnly ? 'ON' : 'off'}`);
      }
      if (selectedLinkedCalendarEventId.trim()) {
        payload.linkedCalendarEventId = selectedLinkedCalendarEventId.trim();
      }
      // Read BEFORE the reset below: the form forgets who it posted as.
      const landing = landingFeedFor({
        asAssociation: isAssociationIdentity(selectedAssociationId),
        scheduled: !!scheduledAt,
      });

      stage = 'mediaUpload';
      // The post's id is minted HERE: the server stores the post under it, so a resend of a create
      // whose answer was lost is the same post (`post-client-id.ts` in social-service).
      await enqueuePost(
        userId,
        {
          id: crypto.randomUUID(),
          queuedAt: Date.now(),
          payload,
          media: selectedFiles.map((f, i) => {
            const caption = mediaCaptions[i]?.trim();
            return { name: f.name, type: f.type, size: f.size, ...(caption ? { caption } : {}) };
          }),
          landing,
        },
        selectedFiles
      );

      // Reset all state once the post is safely queued
      clearPostComposerDraft();
      draftRestored = false;
      draftRestoredMedia = false;
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
      studentsOnly = false;
      // The hold effect would forget the media only on its next flush, and `onPostCreated` unmounts
      // this composer before that: the next open brought the PUBLISHED media back. Said here, now.
      holdPostComposerMedia([]);
      onPostCreated(landing);
    } catch (err) {
      // ACCUSED IN THE CONSOLE, EXPLAINED ON SCREEN: the one failure a reader reports.
      console.error(`[POST_COMPOSER] publish failed at ${stage}`, err);
      errorMessage =
        stage === 'mediaUpload'
          ? isQuotaError(err)
            ? m.publish_queue_enqueue_storage_full()
            : m.publish_queue_enqueue_error()
          : publishFailureMessage(err, m.post_create_publish_error());
    } finally {
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
<div
  class="relative flex min-h-0 flex-1 flex-col"
  role="group"
  aria-label={m.post_create_message_placeholder()}
  use:composerDropZone={{ onFiles: addFiles, onActiveChange: (v) => (dropActive = v) }}
>
  {#if dropActive}
    <div
      transition:fade={{ duration: 150 }}
      class="border-cn-accent bg-cn-surface/80 pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-lg border-2 border-dashed"
    >
      <span class="text-cn-ink flex items-center gap-2 text-sm font-bold">
        <CloudUpload size={18} strokeWidth={2.5} />
        {m.post_drop_overlay()}
      </span>
    </div>
  {/if}
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

    {#if studentsOnlyAssociation}
      <div class="mt-3" transition:fade={{ duration: 200 }}>
        <StudentsOnlySwitch
          bind:checked={studentsOnly}
          associationName={studentsOnlyAssociation.name}
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
          <span class="font-medium opacity-70"
            >{draftRestoredMedia
              ? m.post_create_draft_restored_detail_with_media()
              : m.post_create_draft_restored_detail()}</span
          >
        </span>
        <button
          type="button"
          onclick={() => {
            // The draft is all of it: the media it brought back go with the text.
            filePreviews.forEach((url) => url && URL.revokeObjectURL(url));
            selectedFiles = [];
            filePreviews = [];
            fileThumbIcons = [];
            captionIndex = null;
            applyComposerDraft(emptyPostComposerDraft());
            clearPostComposerDraft();
            draftRestored = false;
            draftRestoredMedia = false;
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
        {#each selectedFiles as file, i (`${i}:${file.name}`)}
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
                  <span class="text-2xs w-full truncate px-2 text-center font-bold uppercase">
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

    <PostComposerBar
      onFiles={addFiles}
      attachmentCount={selectedFiles.length}
      onFormat={(type) => editorField?.format(type)}
      pollActive={includePoll}
      onTogglePoll={() => (includePoll = !includePoll)}
      formActive={includeForm}
      onToggleForm={() => (includeForm = !includeForm)}
      bind:scheduledAt
      status={draftSaved ? m.post_create_draft_saved_label() : ''}
      onLive={livesAvailable(serverLivesMode()) &&
      !isAnonymousSelected &&
      (!isAssociationSelected || liveAssociation)
        ? goLive
        : undefined}
      reel={reelAllowed
        ? {
            start: { caption: markdown, identity: selectedAssociationId, studentsOnly },
            onpublished: onReelPublished,
          }
        : undefined}
    >
      {#snippet action()}
        <Button
          type="button"
          class="shrink-0"
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
