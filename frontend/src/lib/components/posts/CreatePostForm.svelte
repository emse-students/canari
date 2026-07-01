<script lang="ts">
  import {
    Image,
    ChartColumn,
    CalendarCheck,
    ClipboardList,
    Clock,
    X,
    CircleAlert,
    Building2,
    User,
    ChevronDown,
  } from '@lucide/svelte';
  import { slide, fade } from 'svelte/transition';
  import { onMount } from 'svelte';
  import { MediaService, compressImage, IMAGE_COMPRESS_PRESETS } from '$lib/media';
  import { getToken } from '$lib/stores/auth';
  import { createPost, type CreatePostPayload } from '$lib/posts/api';
  import { assertNotMuted } from '$lib/moderation/muteCheck';
  import { getForms, type Form } from '$lib/forms/api';
  import {
    buildCreateFormHref,
    clearPostComposerDraft,
    emptyPostComposerDraft,
    loadPostComposerDraft,
    POST_NEW_FORM_ID_KEY,
    savePostComposerDraft,
    type PostComposerDraft,
  } from '$lib/posts/postComposerDraft';
  import {
    listAssociations,
    listMyAssociations,
    listLinkableValidatedCalendarEvents,
    type Association,
    type AssociationCalendarEvent,
  } from '$lib/associations/api';
  import { groupAssociationsForSelect, listOptionLabel } from '$lib/associations/selectGroups';
  import { isGlobalAdmin } from '$lib/stores/user';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import { trimComposerText } from '$lib/utils/markdown/composerText';
  import PollSection from './PollSection.svelte';
  import FormSection from './FormSection.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  /**
   * Full-featured post creation form. Supports:
   * - Markdown text with auto-saved draft
   * - Image uploads (encrypted via MediaService)
   * - Poll, event registration button, or standalone form attachment
   * - Scheduled publication
   * - Posting as an association (admin/owner role required)
   */
  interface Props {
    /** Called after the post is successfully created so the parent can refresh its list. */
    onPostCreated: () => void;
  }

  let { onPostCreated }: Props = $props();

  // --- Text & images ---
  let markdown = $state('');
  let selectedFiles = $state<File[]>([]);
  let filePreviews = $state<string[]>([]);
  let imageCaptions = $state<string[]>([]);

  // --- Optional sections ---
  let includePoll = $state(false);
  let pollQuestion = $state('');
  let pollOptionsRaw = $state('Oui\nNon');
  let pollMultipleChoice = $state(false);

  let includeForm = $state(false);
  let selectedFormId = $state('');
  let availableForms = $state<Form[]>([]);

  // --- Scheduled publication ---
  let scheduledAt = $state('');

  // --- Association identity ---
  let myAssociations = $state<Association[]>([]);
  let selectedAssociationId = $state('');
  let selectedPaymentAssociationId = $state('');
  let selectedLinkedCalendarEventId = $state('');
  let linkableCalendarEvents = $state<AssociationCalendarEvent[]>([]);
  let loadingLinkableEvents = $state(false);

  /** Associations the user may post as (admin/owner). Global admins can post as any. */
  let postAsAssociations = $derived(
    isGlobalAdmin() ? myAssociations : myAssociations.filter((a) => a.isAdmin)
  );
  /** Same set split into Associations / Listes groups for the picker. */
  let postAsGroups = $derived(groupAssociationsForSelect(postAsAssociations));
  /** Associations with completed Stripe onboarding (eligible for payment collection). */
  let payableAssociations = $derived(postAsAssociations.filter((a) => a.stripeOnboardingComplete));

  // --- UI state ---
  let publishing = $state(false);
  let errorMessage = $state('');
  let authToken = $state('');
  // --- Draft auto-save (full composer state; images are not persisted) ---
  let draftRestored = $state(false);
  let draftSaved = $state(false);
  let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;

  function snapshotComposerDraft(): PostComposerDraft {
    return {
      version: 1,
      markdown,
      imageCaptions: [...imageCaptions],
      includePoll,
      pollQuestion,
      pollOptionsRaw,
      pollMultipleChoice,
      includeForm,
      selectedFormId,
      scheduledAt,
      selectedAssociationId,
      selectedPaymentAssociationId,
      selectedLinkedCalendarEventId,
    };
  }

  function applyComposerDraft(draft: PostComposerDraft) {
    markdown = draft.markdown;
    imageCaptions = draft.imageCaptions ?? [];
    includePoll = draft.includePoll;
    pollQuestion = draft.pollQuestion;
    pollOptionsRaw = draft.pollOptionsRaw;
    pollMultipleChoice = draft.pollMultipleChoice;
    includeForm = draft.includeForm;
    selectedFormId = draft.selectedFormId;
    scheduledAt = draft.scheduledAt;
    selectedAssociationId = draft.selectedAssociationId;
    selectedPaymentAssociationId = draft.selectedPaymentAssociationId;
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
      if (snap.markdown.trim() || snap.includePoll || snap.includeForm) {
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

  /** Auto-clear error banner after 5 seconds. */
  $effect(() => {
    if (errorMessage) {
      const timer = setTimeout(() => {
        errorMessage = '';
      }, 5000);
      return () => clearTimeout(timer);
    }
  });

  /** Load validated agenda events when posting as an association. */
  $effect(() => {
    const assoId = selectedAssociationId;
    selectedLinkedCalendarEventId = '';
    linkableCalendarEvents = [];
    if (!assoId) return;
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

  function formatLinkableEventLabel(ev: AssociationCalendarEvent): string {
    const locale = getLocale() === 'en' ? 'en-US' : 'fr-FR';
    const d = new Date(ev.startsAt);
    const date = d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    return `${date} ${time} - ${ev.title}`;
  }

  const mediaService = new MediaService();
  const imageInputId = 'create-post-images-input';

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
      myAssociations = isGlobalAdmin() ? await listAssociations() : await listMyAssociations();
    } catch (e) {
      console.error('Failed to load associations', e);
    }
  });

  /** Replace the current image selection with a new set of files. Revokes stale object URLs. */
  function onPickFiles(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []).filter((f) => f.type.startsWith('image/'));
    filePreviews.forEach((url) => URL.revokeObjectURL(url));
    selectedFiles = files;
    filePreviews = files.map((f) => URL.createObjectURL(f));
    imageCaptions = files.map(() => '');
  }

  /** Remove a single image from the selection by index. */
  function removeFile(i: number) {
    URL.revokeObjectURL(filePreviews[i]);
    selectedFiles = selectedFiles.filter((_, idx) => idx !== i);
    filePreviews = filePreviews.filter((_, idx) => idx !== i);
    imageCaptions = imageCaptions.filter((_, idx) => idx !== i);
  }

  /** Upload images, assemble the payload, call createPost, then reset the form. */
  async function publishPost() {
    publishing = true;
    errorMessage = '';
    try {
      markdown = trimComposerText(markdown);
      await assertNotMuted();
      if (!markdown.trim() && selectedFiles.length === 0) {
        throw new Error(m.post_create_content_required());
      }
      if (selectedFiles.length > 0 && !authToken) {
        try {
          authToken = await getToken();
        } catch {
          throw new Error(m.post_create_image_token_error());
        }
      }

      // Compress then encrypt-upload each image; collect the resulting refs.
      const images = [];
      for (let i = 0; i < selectedFiles.length; i++) {
        const { maxWidth, maxHeight, quality } = IMAGE_COMPRESS_PRESETS.post;
        const compressed = await compressImage(selectedFiles[i], maxWidth, maxHeight, quality);
        const ref = await mediaService.encryptAndUpload(compressed.file, authToken, {
          width: compressed.width,
          height: compressed.height,
        });
        const caption = imageCaptions[i]?.trim();
        images.push({ ...ref, ...(caption ? { caption } : {}) });
      }

      const payload: CreatePostPayload = {
        markdown,
        images,
        ...(scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
      };

      if (includePoll) {
        const options = pollOptionsRaw
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((label) => ({ label }));
        if (!pollQuestion.trim() || options.length < 2) {
          throw new Error(m.post_create_poll_requires_options());
        }
        payload.polls = [
          { question: pollQuestion.trim(), options, multipleChoice: pollMultipleChoice },
        ];
      }

      if (includeForm) {
        if (!selectedFormId) throw new Error(m.post_create_form_required());
        payload.attachedFormId = selectedFormId;
      }

      if (selectedAssociationId) payload.associationId = selectedAssociationId;
      if (selectedLinkedCalendarEventId.trim()) {
        payload.linkedCalendarEventId = selectedLinkedCalendarEventId.trim();
      }
      if (selectedPaymentAssociationId) payload.paymentAssociationId = selectedPaymentAssociationId;

      await createPost(payload);

      // Reset all state after successful creation
      clearPostComposerDraft();
      draftRestored = false;
      markdown = '';
      filePreviews.forEach((url) => URL.revokeObjectURL(url));
      selectedFiles = [];
      filePreviews = [];
      imageCaptions = [];
      includePoll = false;
      pollQuestion = '';
      pollOptionsRaw = 'Oui\nNon';
      includeForm = false;
      scheduledAt = '';
      selectedAssociationId = '';
      selectedPaymentAssociationId = '';
      selectedLinkedCalendarEventId = '';
      onPostCreated();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : m.post_create_publish_error();
    } finally {
      publishing = false;
    }
  }
</script>

<article
  class="relative mb-6 overflow-hidden rounded-[2rem] border border-black/5 dark:border-white/10 bg-white/70 dark:bg-[#151B2C]/70 shadow-sm backdrop-blur-2xl transition-all duration-300 focus-within:shadow-lg focus-within:border-amber-500/30"
>
  <!-- En-tête du Formulaire -->
  <div class="border-b border-black/5 dark:border-white/10 bg-white/40 dark:bg-black/20 px-5 py-4">
    <p class="text-[0.65rem] font-extrabold uppercase tracking-widest text-amber-500 mb-0.5">
      {m.post_create_title()}
    </p>
    <p class="text-sm font-semibold text-text-main opacity-90">
      {m.post_create_subtitle()}
    </p>
  </div>

  <div class="p-4 sm:p-5">
    <!-- Sélecteurs d'Association (Affichés uniquement si l'utilisateur gère une asso) -->
    {#if postAsAssociations.length > 0}
      <div class="mb-5 grid gap-4 sm:grid-cols-2">
        <!-- Publier en tant que -->
        <div>
          <label
            for="post-association-select"
            class="mb-1.5 flex items-center gap-1.5 text-[0.65rem] font-extrabold uppercase tracking-wider text-text-muted ml-1"
          >
            {m.post_create_post_as_label()}
          </label>
          <div class="relative group">
            <span
              class="pointer-events-none absolute left-3.5 top-1/2 z-[1] -translate-y-1/2 text-text-muted group-focus-within:text-amber-500 transition-colors"
              aria-hidden="true"
            >
              {#if selectedAssociationId}<Building2 size={16} strokeWidth={2.5} />{:else}<User
                  size={16}
                  strokeWidth={2.5}
                />{/if}
            </span>
            <select
              id="post-association-select"
              bind:value={selectedAssociationId}
              class="w-full appearance-none rounded-xl border border-black/5 dark:border-white/10 bg-black/5 dark:bg-white/5 pl-10 pr-10 py-3 text-sm font-bold text-text-main shadow-inner transition-all outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer"
            >
              <option value="" class="bg-white dark:bg-zinc-900 font-medium"
                >{m.post_create_personal_profile_label()}</option
              >
              {#if postAsGroups.assos.length > 0}
                <optgroup label={m.post_create_associations_group_label()}>
                  {#each postAsGroups.assos as a (a.id)}
                    <option value={a.id} class="bg-white dark:bg-zinc-900 font-medium">{a.name}</option
                    >
                  {/each}
                </optgroup>
              {/if}
              {#if postAsGroups.lists.length > 0}
                <optgroup label={m.post_create_lists_group_label()}>
                  {#each postAsGroups.lists as a (a.id)}
                    <option value={a.id} class="bg-white dark:bg-zinc-900 font-medium"
                      >{listOptionLabel(a)}</option
                    >
                  {/each}
                </optgroup>
              {/if}
            </select>
            <div
              class="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-text-muted group-focus-within:text-amber-500 transition-colors"
            >
              <ChevronDown size={16} strokeWidth={2.5} />
            </div>
          </div>
        </div>

        <!-- Encaissement Stripe (Affiché uniquement si une asso est sélectionnée) -->
        {#if payableAssociations.length > 0 && selectedAssociationId}
          <div transition:fade={{ duration: 200 }}>
            <label
              for="post-payment-association-select"
              class="mb-1.5 flex items-center gap-1.5 text-[0.65rem] font-extrabold uppercase tracking-wider text-text-muted ml-1"
            >
              {m.post_create_payment_account_label()}
            </label>
            <div class="relative group">
              <span
                class="pointer-events-none absolute left-3.5 top-1/2 z-[1] -translate-y-1/2 text-amber-500"
                aria-hidden="true"
              >
                <Building2 size={16} strokeWidth={2.5} />
              </span>
              <select
                id="post-payment-association-select"
                bind:value={selectedPaymentAssociationId}
                class="w-full appearance-none rounded-xl border border-black/5 dark:border-white/10 bg-black/5 dark:bg-white/5 pl-10 pr-10 py-3 text-sm font-bold text-text-main shadow-inner transition-all outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer"
              >
                <option value="" class="bg-white dark:bg-zinc-900 font-medium"
                  >{m.post_create_no_linked_account_label()}</option
                >
                {#each payableAssociations as a (a.id)}
                  <option value={a.id} class="bg-white dark:bg-zinc-900 font-medium"
                    >{a.name}</option
                  >
                {/each}
              </select>
              <div
                class="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-text-muted group-focus-within:text-amber-500 transition-colors"
              >
                <ChevronDown size={16} strokeWidth={2.5} />
              </div>
            </div>
          </div>
        {/if}

        {#if selectedAssociationId}
          <div class="sm:col-span-2" transition:fade={{ duration: 200 }}>
            <label
              for="post-linked-calendar-event"
              class="mb-1.5 flex items-center gap-1.5 text-[0.65rem] font-extrabold uppercase tracking-wider text-text-muted ml-1"
            >
              <CalendarCheck size={14} strokeWidth={2.5} class="text-amber-500" />
              {m.post_create_link_event_label()}
            </label>
            <select
              id="post-linked-calendar-event"
              bind:value={selectedLinkedCalendarEventId}
              disabled={loadingLinkableEvents}
              class="w-full appearance-none rounded-xl border border-black/5 dark:border-white/10 bg-black/5 dark:bg-white/5 px-4 py-3 text-sm font-bold text-text-main shadow-inner transition-all outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer disabled:opacity-60"
            >
              <option value="" class="bg-white dark:bg-zinc-900 font-medium">
                {loadingLinkableEvents ? m.common_loading_label() : m.post_create_no_event_label()}
              </option>
              {#each linkableCalendarEvents as ev (ev.id)}
                <option value={ev.id} class="bg-white dark:bg-zinc-900 font-medium">
                  {formatLinkableEventLabel(ev)}
                </option>
              {/each}
            </select>
            <p class="mt-1.5 text-[0.7rem] text-text-muted ml-1">
              {m.post_create_validated_events_hint()}
            </p>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Bannière Brouillon Restauré -->
    {#if draftRestored}
      <div
        class="mb-3 flex items-center justify-between rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 shadow-sm"
        transition:slide={{ duration: 200 }}
      >
        <span
          class="text-[0.75rem] font-bold text-amber-700 dark:text-amber-400 flex items-center gap-1.5"
        >
          {m.post_create_draft_restored_label()}
          <span class="font-medium text-amber-700/70 dark:text-amber-400/70"
            >{m.post_create_draft_restored_detail()}</span
          >
        </span>
        <button
          type="button"
          onclick={() => {
            applyComposerDraft(emptyPostComposerDraft());
            clearPostComposerDraft();
            draftRestored = false;
          }}
          class="text-xs font-bold text-amber-700/60 dark:text-amber-400/60 hover:text-amber-700 dark:hover:text-amber-400 transition-colors outline-none focus-visible:underline"
        >
          {m.post_create_clear_draft_label()}
        </button>
      </div>
    {/if}

    <!-- Zone de Texte & Aperçu Médias (Inner Shadow Container) -->
    <div
      class="relative rounded-[1.5rem] border border-black/5 dark:border-white/10 bg-black/5 dark:bg-black/40 shadow-inner p-2 mb-2 transition-colors focus-within:bg-white/50 dark:focus-within:bg-black/60"
    >
      <!-- Feedback de Sauvegarde auto -->
      {#if draftSaved}
        <span
          class="pointer-events-none absolute right-4 top-3 text-[0.65rem] font-bold uppercase tracking-wider text-text-muted opacity-60"
          transition:fade={{ duration: 200 }}
        >
          {m.post_create_draft_saved_label()}
        </span>
      {/if}

      <MarkdownComposerField
        bind:value={markdown}
        placeholder={m.post_create_message_placeholder()}
        minHeight="120px"
        toolbarClass="mb-1"
        editorClass="custom-scrollbar min-h-[120px] w-full max-w-full rounded-xl bg-transparent px-4 py-3.5 text-[0.95rem] sm:text-[1rem] font-medium leading-relaxed text-text-main"
      />

      <!-- Aperçu des images & Légendes -->
      {#if filePreviews.length > 0}
        <div
          class="flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-3 pb-3 pt-2 custom-scrollbar"
          transition:slide={{ duration: 200 }}
          role="list"
        >
          {#each filePreviews as src, i (src)}
            <div
              class="flex w-[100px] shrink-0 snap-start flex-col gap-2 sm:w-[120px]"
              role="listitem"
            >
              <!-- Miniature -->
              <div
                class="relative aspect-square w-full overflow-hidden rounded-2xl border border-black/10 dark:border-white/10 shadow-sm group"
              >
                <img
                  {src}
                  alt={m.post_create_image_preview_alt()}
                  class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                />
                <button
                  type="button"
                  onclick={() => removeFile(i)}
                  class="absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1.5 text-white shadow-sm backdrop-blur-md transition-all hover:bg-red-500 hover:scale-110 active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-red-400 opacity-0 group-hover:opacity-100 focus:opacity-100"
                  aria-label={m.post_create_remove_image_label()}
                  title={m.common_delete_button()}
                >
                  <X size={14} strokeWidth={2.5} />
                </button>
              </div>
              <!-- Input Légende -->
              <input
                type="text"
                bind:value={imageCaptions[i]}
                placeholder={m.post_create_caption_placeholder()}
                maxlength="120"
                class="w-full rounded-lg border border-black/10 dark:border-white/10 bg-white/70 dark:bg-black/40 px-2.5 py-1.5 text-[0.7rem] font-semibold text-text-main placeholder:text-text-muted/60 outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500/30 transition-all shadow-inner"
              />
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Sections Optionnelles & Footer -->
  <div class="space-y-4 border-t border-black/5 dark:border-white/10 px-4 pb-5 pt-5 sm:px-5">
    <!-- Sondage -->
    {#if includePoll}
      <div transition:slide={{ duration: 300, easing: (t) => t * (2 - t) }}>
        <PollSection
          bind:question={pollQuestion}
          bind:optionsRaw={pollOptionsRaw}
          bind:multipleChoice={pollMultipleChoice}
          onRemove={() => (includePoll = false)}
        />
      </div>
    {/if}

    <!-- Formulaire attaché -->
    {#if includeForm}
      <div transition:slide={{ duration: 300, easing: (t) => t * (2 - t) }}>
        <FormSection
          bind:selectedFormId
          {availableForms}
          createFormHref={buildCreateFormHref()}
          onBeforeCreateForm={persistComposerDraft}
          onRemove={() => (includeForm = false)}
        />
      </div>
    {/if}

    <!-- Bannière d'Erreur -->
    {#if errorMessage}
      <div
        transition:slide={{ duration: 200 }}
        class="flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-red-600 dark:text-red-400 shadow-inner"
      >
        <CircleAlert size={18} strokeWidth={2.5} class="mt-0.5 shrink-0" />
        <span class="text-sm font-bold leading-snug">{errorMessage}</span>
      </div>
    {/if}

    <!-- Barre d'outils (Toggles) + Bouton Publier -->
    <div class="flex flex-col-reverse gap-4 pt-1 sm:flex-row sm:items-center sm:justify-between">
      <!-- Boutons d'ajouts (Toolbar) -->
      <div
        class="custom-scrollbar flex flex-wrap items-center gap-2 overflow-x-auto rounded-[1.25rem] bg-white/50 dark:bg-black/20 p-1.5 shadow-inner border border-black/5 dark:border-white/5 w-full sm:w-auto"
      >
        <!-- Ajouter des photos -->
        <label
          for={imageInputId}
          title={m.post_create_photos_label()}
          class="flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-text-muted transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 shrink-0
          {selectedFiles.length > 0
            ? 'bg-amber-500/15 font-bold text-amber-600 dark:text-amber-400 shadow-sm'
            : 'hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main'}"
        >
          <Image size={18} strokeWidth={selectedFiles.length > 0 ? 2.5 : 2} />
          <span class="hidden text-xs sm:inline">{m.post_create_photos_label()}</span>
        </label>
        <input
          id={imageInputId}
          type="file"
          accept="image/*"
          multiple
          onchange={onPickFiles}
          class="sr-only"
        />

        <!-- Ajouter un sondage -->
        <button
          type="button"
          title={m.post_poll_section_title()}
          onclick={() => (includePoll = !includePoll)}
          class="flex items-center gap-2 rounded-xl px-3 py-2 text-text-muted transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 shrink-0
          {includePoll
            ? 'bg-amber-500/15 font-bold text-amber-600 dark:text-amber-400 shadow-sm'
            : 'hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main'}"
        >
          <ChartColumn size={18} strokeWidth={includePoll ? 2.5 : 2} />
          <span class="hidden text-xs sm:inline">{m.post_poll_section_title()}</span>
        </button>

        <!-- Ajouter un formulaire -->
        <button
          type="button"
          title={m.post_form_fallback_title()}
          onclick={() => (includeForm = !includeForm)}
          class="flex items-center gap-2 rounded-xl px-3 py-2 text-text-muted transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 shrink-0
          {includeForm
            ? 'bg-amber-500/15 font-bold text-amber-600 dark:text-amber-400 shadow-sm'
            : 'hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main'}"
        >
          <ClipboardList size={18} strokeWidth={includeForm ? 2.5 : 2} />
          <span class="hidden text-xs sm:inline">{m.post_form_fallback_title()}</span>
        </button>

        <!-- Séparateur vertical visuel -->
        <div class="h-6 w-px bg-black/10 dark:bg-white/10 mx-0.5 shrink-0 hidden sm:block"></div>

        <!-- Programmation (Date Picker intégré) -->
        <div
          class="relative flex items-center bg-black/5 dark:bg-white/5 rounded-xl px-2 py-1.5 focus-within:ring-2 focus-within:ring-amber-500/50 transition-all shrink-0 {scheduledAt
            ? 'bg-amber-500/10 border border-amber-500/20'
            : ''}"
        >
          <Clock
            size={16}
            strokeWidth={2.5}
            class="ml-1 text-text-muted {scheduledAt ? 'text-amber-600 dark:text-amber-400' : ''}"
          />
          <input
            type="datetime-local"
            bind:value={scheduledAt}
            min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
            title={m.post_create_schedule_publication_label()}
            class="bg-transparent pl-2 pr-1 text-[0.7rem] font-bold text-text-main outline-none cursor-pointer {scheduledAt
              ? 'w-36 text-amber-700 dark:text-amber-400'
              : 'w-5 sm:w-28 text-transparent sm:text-text-main'} transition-all"
          />
          {#if scheduledAt}
            <button
              type="button"
              onclick={() => (scheduledAt = '')}
              class="rounded-full p-1 text-text-muted transition-colors hover:text-red-500 hover:bg-red-500/10 outline-none"
              title={m.post_create_cancel_schedule_label()}
            >
              <X size={14} strokeWidth={2.5} />
            </button>
          {/if}
        </div>
      </div>

      <!-- Bouton Publier / Programmer -->
      <Button
        type="button"
        class="min-w-[10rem] shrink-0 px-8 py-3 text-sm !font-extrabold sm:w-auto shadow-md shadow-amber-500/20 active:translate-y-0"
        disabled={publishing || (!markdown.trim() && selectedFiles.length === 0)}
        loading={publishing}
        onclick={publishPost}
      >
        {#if publishing}
          {scheduledAt
            ? m.post_create_scheduling_in_progress_label()
            : m.post_create_publishing_in_progress_label()}
        {:else}
          {scheduledAt ? m.post_create_schedule_button_label() : m.post_create_publish_button_label()}
        {/if}
      </Button>
    </div>
  </div>
</article>

<style>
  .custom-scrollbar::-webkit-scrollbar {
    width: 4px;
    height: 4px;
  }
  .custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--cn-surface) 20%, transparent);
    border-radius: 4px;
  }
  :global([data-theme='dark']) .custom-scrollbar::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.15);
  }

  /* Pour cacher la petite icône calendrier native sur Webkit et avoir juste l'icône personnalisée Lucide */
  input[type='datetime-local']::-webkit-calendar-picker-indicator {
    cursor: pointer;
    opacity: 0;
    position: absolute;
    left: 0;
    width: 100%;
    height: 100%;
  }
</style>
