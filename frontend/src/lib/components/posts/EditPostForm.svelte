<script lang="ts">
  import { needsThumbIcon } from '$lib/utils/mediaLayout';
  import { Log } from '$lib/utils/Log';
  import { FileText, Film, Music, CalendarCheck, CircleAlert } from '@lucide/svelte';
  import { slide } from 'svelte/transition';
  import { onMount, untrack } from 'svelte';
  import { MediaService, preparePostMedia } from '$lib/media';
  import { getToken } from '$lib/stores/auth';
  import {
    updatePost,
    type PostEntity,
    type PostMediaRef,
    type UpdatePostPayload,
  } from '$lib/posts/api';
  import { getForms, type Form } from '$lib/forms/api';
  import { buildCreateFormHref } from '$lib/posts/postComposerDraft';
  import {
    listLinkableValidatedCalendarEvents,
    type AssociationCalendarEvent,
  } from '$lib/associations/api';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import { trimComposerText } from '$lib/utils/markdown/composerText';
  import { m } from '$lib/paraglide/messages';
  import { linkableEventPickerOptions } from '$lib/utils/time';
  import PollSection from './PollSection.svelte';
  import PostComposerBar from './PostComposerBar.svelte';
  import MediaThumbRemoveButton from './MediaThumbRemoveButton.svelte';
  import PickedMediaPreview from './PickedMediaPreview.svelte';
  import MediaCaptionChip from './MediaCaptionChip.svelte';
  import MediaCaptionField from './MediaCaptionField.svelte';
  import { shiftAfterRemoval } from './mediaCaptionIndex';
  import Picker from '$lib/components/ui/Picker.svelte';
  import { localPublishBlocker } from '$lib/posts/composerReadiness';
  import { publishFailureMessage } from '$lib/posts/publishFailure';
  import { LocalizedError } from '$lib/utils/localizedError';
  import {
    emptyPollOptions,
    filledPollOptions,
    normalizeMaxSelections,
    POLL_MIN_OPTIONS,
    type PollDraft,
    type PollDraftOption,
    type PollDraftIssue,
  } from '$lib/posts/pollDraft';
  import { toDatetimeLocalValue } from '$lib/utils/dates';
  import FormSection from './FormSection.svelte';
  import PostMedia from './PostMedia.svelte';
  import Button from '$lib/components/ui/Button.svelte';

  /**
   * Full-featured post edit form, mirroring CreatePostForm.
   * Supports updating markdown, images, polls, attached form, scheduling,
   * linked calendar event, and payment association.
   * The post's association identity (associationId) is immutable and shown read-only.
   */
  interface Props {
    /** The post to edit. */
    post: PostEntity;
    /** Bearer token for new image uploads and existing image decryption. */
    authToken?: string;
    /** Called with the updated post after a successful save. */
    onSaved: (updated: PostEntity) => void;
    /** Called when the user cancels editing. */
    onCancel: () => void;
  }

  let { post, authToken = '', onSaved, onCancel }: Props = $props();

  // --- Text ---
  let markdown = $state(untrack(() => post.markdown ?? ''));

  // --- Media ---
  // Existing media already uploaded: show with PostMedia, removable.
  let existingMedia = $state<PostMediaRef[]>(untrack(() => [...(post.media ?? post.images ?? [])]));
  // New files chosen locally (not yet uploaded).
  let newFiles = $state<File[]>([]);
  let newFilePreviews = $state<string[]>([]);
  let newFileThumbIcons = $state<boolean[]>([]);
  let newMediaCaptions = $state<string[]>([]);
  /** Which new file's caption field is open under the strip - at most one (`MediaCaptionChip`). */
  let captionIndex = $state<number | null>(null);

  // --- Polls ---
  const _initialPoll = untrack(() => post.polls?.[0]);
  /** Existing poll ID preserved to maintain vote history when options are unchanged. */
  let existingPollId = $state(untrack(() => _initialPoll?.id ?? ''));
  let includePoll = $state(untrack(() => (post.polls?.length ?? 0) > 0));
  let pollQuestion = $state(untrack(() => _initialPoll?.question ?? ''));
  let pollOptions = $state<PollDraftOption[]>(
    untrack(() => {
      // THE STORED IDS COME WITH THEM, and go back out on save: a vote was cast against an option
      // id, so an option that keeps its id keeps its tally. See `posts.service.ts`.
      const stored = (_initialPoll?.options ?? []).map((o: { id: string; label: string }) => ({
        id: o.id,
        label: o.label,
      }));
      return stored.length >= POLL_MIN_OPTIONS ? stored : emptyPollOptions();
    })
  );
  let pollMultipleChoice = $state(untrack(() => _initialPoll?.multipleChoice ?? false));
  let pollMaxSelections = $state<number | null>(untrack(() => _initialPoll?.maxSelections ?? null));
  /**
   * The deadline as it was STORED, so the rule that a deadline must be in the future can tell a
   * date the reader just typed from one they merely opened. A poll that closed yesterday is a
   * perfectly good poll to fix a typo on.
   */
  const _initialEndsAt = untrack(() =>
    _initialPoll?.endsAt ? toDatetimeLocalValue(_initialPoll.endsAt) : ''
  );
  let pollEndsAt = $state(_initialEndsAt);
  /** Which poll field the last refused save was waiting on, shown inside the card. */
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

  // --- Form attachment ---
  let includeForm = $state(untrack(() => !!post.attachedFormId));
  let selectedFormId = $state(untrack(() => post.attachedFormId ?? ''));
  let availableForms = $state<Form[]>([]);

  // --- Scheduled publication ---
  let scheduledAt = $state(
    untrack(() => (post.scheduledAt ? new Date(post.scheduledAt).toISOString().slice(0, 16) : ''))
  );

  // --- Association identity (immutable, but the linked event is editable) ---
  let selectedLinkedCalendarEventId = $state(untrack(() => post.linkedCalendarEventId ?? ''));
  let linkableCalendarEvents = $state<AssociationCalendarEvent[]>([]);
  let loadingLinkableEvents = $state(false);
  const linkableEventOptions = $derived(
    linkableEventPickerOptions(linkableCalendarEvents, loadingLinkableEvents)
  );
  // --- UI state ---
  let saving = $state(false);
  let errorMessage = $state('');
  let currentAuthToken = $state(untrack(() => authToken));
  let editorField = $state<MarkdownComposerField | null>(null);

  /*
   * NO TIMER CLEARS THE ERROR BANNER, for the reason `CreatePostForm` gives at length: this one
   * erased itself after 5 seconds, so a keyboard covering it for that long left an editor that does
   * not save and says nothing. It is cleared by the next attempt, a successful save, or its own
   * dismiss button.
   */

  const mediaService = new MediaService();

  onMount(async () => {
    if (!currentAuthToken) {
      try {
        currentAuthToken = await getToken();
      } catch {
        /* retried on upload */
      }
    }

    try {
      availableForms = await getForms();
    } catch (e) {
      console.error('Failed to load forms for edit', e);
    }

    if (post.associationId) {
      loadingLinkableEvents = true;
      try {
        linkableCalendarEvents = await listLinkableValidatedCalendarEvents(post.associationId);
      } catch (e) {
        console.error('Failed to load linkable calendar events', e);
      } finally {
        loadingLinkableEvents = false;
      }
    }
  });

  /**
   * Adds media to the pending list, whatever route it arrived by.
   *
   * The picker, a drop and a paste all end here: the editor body is Markdown and cannot hold an
   * image, so the only place one can go is this list (user, 2026-09-18).
   */
  function addFiles(files: File[]) {
    if (files.length === 0) return;
    newFiles = [...newFiles, ...files];
    newFilePreviews = [
      ...newFilePreviews,
      ...files.map((f) => (needsThumbIcon(f) ? '' : URL.createObjectURL(f))),
    ];
    newFileThumbIcons = [...newFileThumbIcons, ...files.map((f) => needsThumbIcon(f))];
    newMediaCaptions = [...newMediaCaptions, ...files.map(() => '')];
  }

  /** Removes an existing media item (already uploaded) by index. */
  function removeExistingMedia(i: number) {
    existingMedia = existingMedia.filter((_, idx) => idx !== i);
  }

  /** Removes a newly picked (not yet uploaded) file by index. */
  function removeNewFile(i: number) {
    if (newFilePreviews[i]) URL.revokeObjectURL(newFilePreviews[i]);
    newFiles = newFiles.filter((_, idx) => idx !== i);
    newFilePreviews = newFilePreviews.filter((_, idx) => idx !== i);
    newFileThumbIcons = newFileThumbIcons.filter((_, idx) => idx !== i);
    newMediaCaptions = newMediaCaptions.filter((_, idx) => idx !== i);
    captionIndex = shiftAfterRemoval(captionIndex, i);
  }

  /** Icon matching the media type for generic file previews. */
  function fileTypeIcon(file: File) {
    if (file.type.startsWith('video/')) return Film;
    if (file.type.startsWith('audio/')) return Music;
    return FileText;
  }

  async function submitEdit() {
    Log.d('POST_EDITOR', 'submitEdit');
    saving = true;
    errorMessage = '';
    try {
      markdown = trimComposerText(markdown);

      // THE SAME RULE AS THE COMPOSER'S, FROM THE SAME MODULE, AND BEFORE ANY UPLOAD. It ran after
      // the uploads, behind an empty-content check that threw English dev prose - which the catch
      // below replaced with "Impossible d'enregistrer", so an editor was told nothing at all, and a
      // poll with one option still paid for every new photo first. `localPublishBlocker` counts
      // media without needing them uploaded, so the question is answered here, for nothing.
      const blocker = localPublishBlocker({
        markdown,
        fileCount: existingMedia.length + newFiles.length,
        poll: pollDraft,
        storedPollEndsAt: _initialEndsAt,
        form: includeForm ? { selectedFormId, availableCount: availableForms.length } : null,
      });
      pollIssue = blocker?.pollIssue ?? null;
      if (blocker) throw new LocalizedError(blocker.message);

      if (newFiles.length > 0 && !currentAuthToken) {
        try {
          currentAuthToken = await getToken();
        } catch {
          throw new LocalizedError(m.post_create_image_token_error());
        }
      }

      // Upload new media files and get their refs.
      const uploadedRefs: PostMediaRef[] = [];
      for (let i = 0; i < newFiles.length; i++) {
        const { file, dims } = await preparePostMedia(newFiles[i]);
        const ref = await mediaService.encryptAndUpload(file, currentAuthToken, dims, 'archive');
        const caption = newMediaCaptions[i]?.trim();
        uploadedRefs.push({ ...ref, ...(caption ? { caption } : {}) });
      }

      const allMedia = [...existingMedia, ...uploadedRefs];

      const payload: UpdatePostPayload = {
        markdown,
        media: allMedia,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        attachedFormId: includeForm && selectedFormId ? selectedFormId : null,
        linkedCalendarEventId: selectedLinkedCalendarEventId || null,
      };

      if (includePoll) {
        const options = filledPollOptions(pollOptions);
        payload.polls = [
          {
            ...(existingPollId ? { id: existingPollId } : {}),
            question: pollQuestion.trim(),
            options,
            multipleChoice: pollMultipleChoice,
            maxSelections: normalizeMaxSelections(
              pollMaxSelections,
              options.length,
              pollMultipleChoice
            ),
            endsAt: pollEndsAt ? new Date(pollEndsAt).toISOString() : null,
          },
        ];
      } else {
        payload.polls = [];
      }

      const updated = await updatePost(post.id, payload);

      // Revoke new previews now that upload succeeded.
      newFilePreviews.forEach((url) => URL.revokeObjectURL(url));
      onSaved(updated);
    } catch (err) {
      // Accused, not debug-logged: this is the one failure an editor reports (see CreatePostForm).
      console.error('[POST_EDITOR] save failed', err);
      errorMessage = publishFailureMessage(err, m.post_edit_save_error());
    } finally {
      saving = false;
    }
  }
</script>

<article
  class="bg-cn-surface relative overflow-hidden rounded-lg border border-black/5 shadow-sm transition-all duration-300 focus-within:border-amber-500/30 focus-within:shadow-lg dark:border-white/10"
>
  <!-- Header: what this is, and - since the identity cannot change - who it is published as. -->
  <div class="border-cn-border border-b px-5 py-3">
    <p class="text-text-main text-sm font-bold">{m.post_edit_post_label()}</p>
    {#if post.association}
      <p class="text-text-muted text-2xs mt-0.5 font-semibold">
        {m.post_edit_published_as()}
        <span class="text-amber-600 dark:text-amber-400">{post.association.name}</span>
      </p>
    {/if}
  </div>

  <div class="p-4 sm:p-5">
    <!-- Association selectors (linked event) for association posts. -->
    {#if post.associationId}
      <div class="mb-5 grid gap-4 sm:grid-cols-2">
        <!-- Link to a validated event. -->
        <div class="sm:col-span-2">
          <label
            for="edit-post-linked-calendar-event"
            class="text-text-muted text-2xs mb-1.5 ml-1 flex items-center gap-1.5 font-bold tracking-wider uppercase"
          >
            <CalendarCheck size={14} strokeWidth={2.5} class="text-amber-500" />
            {m.post_create_link_event_label()}
          </label>
          <Picker
            id="edit-post-linked-calendar-event"
            value={selectedLinkedCalendarEventId}
            options={linkableEventOptions}
            onValueChange={(v) => (selectedLinkedCalendarEventId = v)}
            label={m.post_create_link_event_label()}
            disabled={loadingLinkableEvents}
            variant="field"
          />
          <p class="text-text-muted text-2xs mt-1.5 ml-1">
            {m.post_create_validated_events_hint()}
          </p>
        </div>
      </div>
    {/if}

    <!-- Text area + image preview. -->
    <div
      class="focus-within:bg-cn-surface relative mb-2 rounded-2xl border border-black/5 bg-black/5 p-2 shadow-inner transition-colors dark:border-white/10 dark:bg-black/40 dark:focus-within:bg-black/60"
    >
      <MarkdownComposerField
        bind:this={editorField}
        bind:value={markdown}
        onmedia={addFiles}
        showToolbar={false}
        placeholder={m.post_create_message_placeholder()}
        minHeight="120px"
        editorClass="min-h-[120px] w-full max-w-full rounded-xl bg-transparent px-4 py-3.5 text-sm sm:text-sm font-medium leading-relaxed text-text-main"
      />

      <!-- Existing media + newly added media. -->
      {#if existingMedia.length > 0 || newFiles.length > 0}
        <div
          class="flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-3 pt-2 pb-3"
          transition:slide={{ duration: 200 }}
          role="list"
        >
          <!-- Existing media (already uploaded) -->
          {#each existingMedia as mediaItem, i (mediaItem.mediaId)}
            <div
              class="flex w-[100px] shrink-0 snap-start flex-col gap-2 sm:w-[120px]"
              role="listitem"
            >
              <div
                class="group relative aspect-square w-full overflow-hidden rounded-2xl border border-black/10 shadow-sm dark:border-white/10"
              >
                <PostMedia media={mediaItem} authToken={currentAuthToken} />
                <MediaThumbRemoveButton
                  label={m.post_edit_remove_image_aria()}
                  title={m.common_delete_button()}
                  onclick={() => removeExistingMedia(i)}
                />
              </div>
              {#if mediaItem.caption}
                <p
                  class="text-text-muted text-2xs w-full truncate rounded-lg px-2.5 py-1.5 font-semibold"
                  title={mediaItem.caption}
                >
                  {mediaItem.caption}
                </p>
              {/if}
            </div>
          {/each}

          <!-- New files (local, not yet uploaded). -->
          {#each newFiles as file, i (file.name + i)}
            {@const Icon = fileTypeIcon(file)}
            <div
              class="flex w-[100px] shrink-0 snap-start flex-col gap-2 sm:w-[120px]"
              role="listitem"
            >
              <div
                class="group relative aspect-square w-full overflow-hidden rounded-2xl border border-black/10 shadow-sm dark:border-white/10"
              >
                {#if newFileThumbIcons[i]}
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
                    src={newFilePreviews[i]}
                    alt={m.post_create_image_preview_alt()}
                    class="transition-transform duration-500 group-hover:scale-105"
                  />
                {/if}
                <MediaThumbRemoveButton
                  label={m.post_edit_remove_image_aria()}
                  title={m.common_delete_button()}
                  onclick={() => removeNewFile(i)}
                />
                <MediaCaptionChip
                  hasCaption={!!newMediaCaptions[i]?.trim()}
                  active={captionIndex === i}
                  onclick={() => (captionIndex = captionIndex === i ? null : i)}
                />
              </div>
            </div>
          {/each}
        </div>
        {#if captionIndex !== null && captionIndex < newFiles.length}
          <div class="px-3 pb-3">
            {#key captionIndex}
              <MediaCaptionField
                bind:value={newMediaCaptions[captionIndex]}
                position={existingMedia.length + captionIndex + 1}
                onDone={() => (captionIndex = null)}
              />
            {/key}
          </div>
        {/if}
      {/if}
    </div>
  </div>

  <!-- Optional sections & footer. -->
  <div class="space-y-4 border-t border-black/5 px-4 pt-5 pb-5 sm:px-5 dark:border-white/10">
    <!-- Sondage -->
    {#if includePoll}
      <div transition:slide={{ duration: 300, easing: (t) => t * (2 - t) }}>
        <PollSection
          bind:question={pollQuestion}
          bind:options={pollOptions}
          bind:multipleChoice={pollMultipleChoice}
          bind:maxSelections={pollMaxSelections}
          bind:endsAt={pollEndsAt}
          issue={pollIssue}
          onRemove={() => {
            includePoll = false;
            existingPollId = '';
            pollIssue = null;
          }}
        />
      </div>
    {/if}

    <!-- Attached form. -->
    {#if includeForm}
      <div transition:slide={{ duration: 300, easing: (t) => t * (2 - t) }}>
        <FormSection
          bind:selectedFormId
          {availableForms}
          createFormHref={buildCreateFormHref()}
          onBeforeCreateForm={() => {}}
          onRemove={() => (includeForm = false)}
        />
      </div>
    {/if}

    <!-- Error banner: stays until the next attempt, a save, or the reader dismisses it. -->
    {#if errorMessage}
      <div
        transition:slide={{ duration: 200 }}
        role="alert"
        class="flex items-start gap-2.5 rounded-lg bg-red-500/10 px-3 py-2.5 text-red-600 dark:text-red-400"
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
      onFormat={(type) => editorField?.format(type)}
      pollActive={includePoll}
      onTogglePoll={() => (includePoll = !includePoll)}
      formActive={includeForm}
      onToggleForm={() => (includeForm = !includeForm)}
      bind:scheduledAt
    >
      {#snippet action()}
        <button
          type="button"
          onclick={onCancel}
          class="text-text-muted hover:text-text-main shrink-0 rounded-lg px-3 py-2 text-sm font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
        >
          {m.common_cancel_button()}
        </button>
        <Button
          type="button"
          class="shrink-0 px-5 py-2 text-sm !font-bold"
          disabled={saving ||
            (!markdown.trim() && existingMedia.length === 0 && newFiles.length === 0)}
          loading={saving}
          onclick={submitEdit}
        >
          {saving ? m.common_saving_label() : m.post_edit_save_button()}
        </Button>
      {/snippet}
    </PostComposerBar>
  </div>
</article>
