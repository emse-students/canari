<script lang="ts">
  import {
    Image,
    FileText,
    Film,
    Music,
    ChartColumn,
    CalendarCheck,
    ClipboardList,
    Clock,
    X,
    CircleAlert,
    Building2,
    CreditCard,
    ChevronDown,
  } from '@lucide/svelte';
  import { slide, fade } from 'svelte/transition';
  import { onMount, untrack } from 'svelte';
  import { MediaService, compressImage, IMAGE_COMPRESS_PRESETS } from '$lib/media';
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
    listAssociations,
    listMyAssociations,
    type Association,
    type AssociationCalendarEvent,
  } from '$lib/associations/api';
  import { isGlobalAdmin } from '$lib/stores/user';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import { trimComposerText } from '$lib/utils/markdown/composerText';
  import { m } from '$lib/paraglide/messages';
  import PollSection from './PollSection.svelte';
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

  // --- Polls ---
  const _initialPoll = untrack(() => post.polls?.[0]);
  /** Existing poll ID preserved to maintain vote history when options are unchanged. */
  let existingPollId = $state(untrack(() => _initialPoll?.id ?? ''));
  let includePoll = $state(untrack(() => (post.polls?.length ?? 0) > 0));
  let pollQuestion = $state(untrack(() => _initialPoll?.question ?? ''));
  let pollOptionsRaw = $state(
    untrack(() =>
      (_initialPoll?.options ?? []).length >= 2
        ? (_initialPoll?.options ?? []).map((o: any) => o.label).join('\n')
        : 'Oui\nNon'
    )
  );
  let pollMultipleChoice = $state(untrack(() => _initialPoll?.multipleChoice ?? false));

  // --- Form attachment ---
  let includeForm = $state(untrack(() => !!post.attachedFormId));
  let selectedFormId = $state(untrack(() => post.attachedFormId ?? ''));
  let availableForms = $state<Form[]>([]);

  // --- Scheduled publication ---
  let scheduledAt = $state(
    untrack(() => (post.scheduledAt ? new Date(post.scheduledAt).toISOString().slice(0, 16) : ''))
  );

  // --- Association identity (immutable, but linked event & payment are editable) ---
  let selectedLinkedCalendarEventId = $state(untrack(() => post.linkedCalendarEventId ?? ''));
  let selectedPaymentAssociationId = $state(untrack(() => post.paymentAssociationId ?? ''));
  let linkableCalendarEvents = $state<AssociationCalendarEvent[]>([]);
  let loadingLinkableEvents = $state(false);
  /** Association data for the post's associationId, used to show the payment selector. */
  let postAssociation = $state<Association | null>(null);

  let payableForPayment = $derived(postAssociation?.stripeOnboardingComplete ?? false);

  // --- UI state ---
  let saving = $state(false);
  let errorMessage = $state('');
  let currentAuthToken = $state(untrack(() => authToken));

  /** Auto-clear error banner after 5 seconds. */
  $effect(() => {
    if (errorMessage) {
      const timer = setTimeout(() => {
        errorMessage = '';
      }, 5000);
      return () => clearTimeout(timer);
    }
  });

  const mediaService = new MediaService();
  const mediaInputId = 'edit-post-media-input';

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

      try {
        const assocs = isGlobalAdmin() ? await listAssociations() : await listMyAssociations();
        postAssociation = assocs.find((a) => a.id === post.associationId) ?? null;
      } catch {
        /* non-fatal */
      }
    }
  });

  function formatLinkableEventLabel(ev: AssociationCalendarEvent): string {
    const d = new Date(ev.startsAt);
    const date = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return `${date} ${time} - ${ev.title}`;
  }

  /** Returns true for files whose preview should show a generic icon instead of an object URL. */
  function needsThumbIcon(file: File): boolean {
    return (
      !file.type.startsWith('image/') &&
      !file.type.startsWith('video/') &&
      !file.type.startsWith('audio/')
    );
  }

  /** Appends newly picked files to the new-files list. */
  function onPickFiles(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    newFiles = [...newFiles, ...files];
    newFilePreviews = [
      ...newFilePreviews,
      ...files.map((f) => (needsThumbIcon(f) ? '' : URL.createObjectURL(f))),
    ];
    newFileThumbIcons = [...newFileThumbIcons, ...files.map((f) => needsThumbIcon(f))];
    newMediaCaptions = [...newMediaCaptions, ...files.map(() => '')];
    // Reset input so the same file can be picked again.
    input.value = '';
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
  }

  /** Icon matching the media type for generic file previews. */
  function fileTypeIcon(file: File) {
    if (file.type.startsWith('video/')) return Film;
    if (file.type.startsWith('audio/')) return Music;
    return FileText;
  }

  async function submitEdit() {
    saving = true;
    errorMessage = '';
    try {
      markdown = trimComposerText(markdown);
      if (!markdown.trim() && existingMedia.length === 0 && newFiles.length === 0) {
        throw new Error('Post content or a media attachment is required.');
      }

      if (newFiles.length > 0 && !currentAuthToken) {
        try {
          currentAuthToken = await getToken();
        } catch {
          throw new Error('Failed to obtain an auth token for media upload.');
        }
      }

      // Upload new media files and get their refs.
      const uploadedRefs: PostMediaRef[] = [];
      for (let i = 0; i < newFiles.length; i++) {
        const file = newFiles[i];
        let uploadFile = file;
        let dims: { width: number; height: number } | undefined;
        if (file.type.startsWith('image/')) {
          const { maxWidth, maxHeight, quality } = IMAGE_COMPRESS_PRESETS.post;
          const compressed = await compressImage(file, maxWidth, maxHeight, quality);
          uploadFile = compressed.file;
          dims = { width: compressed.width, height: compressed.height };
        }
        const ref = await mediaService.encryptAndUpload(uploadFile, currentAuthToken, dims);
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
        paymentAssociationId: selectedPaymentAssociationId || null,
      };

      if (includePoll) {
        const options = pollOptionsRaw
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((label) => ({ label }));
        if (!pollQuestion.trim() || options.length < 2) {
          throw new Error('A poll requires a question and at least two options.');
        }
        payload.polls = [
          {
            ...(existingPollId ? { id: existingPollId } : {}),
            question: pollQuestion.trim(),
            options,
            multipleChoice: pollMultipleChoice,
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
      errorMessage = err instanceof Error ? err.message : m.post_edit_save_error();
    } finally {
      saving = false;
    }
  }
</script>

<article
  class="dark:bg-cn-ink/70 relative overflow-hidden rounded-[2rem] border border-black/5 bg-white/70 shadow-sm backdrop-blur-2xl transition-all duration-300 focus-within:border-amber-500/30 focus-within:shadow-lg dark:border-white/10"
>
  <!-- En-tête -->
  <div class="border-b border-black/5 bg-white/40 px-5 py-4 dark:border-white/10 dark:bg-black/20">
    <p class="mb-0.5 text-[0.65rem] font-extrabold tracking-widest text-amber-500 uppercase">
      Modifier la publication
    </p>
    <p class="text-text-main text-sm font-semibold opacity-90">
      {#if post.association}
        {m.post_edit_published_as()}
        <span class="text-amber-600 dark:text-amber-400">{post.association.name}</span>.
      {:else}
        Modifiez le texte, les images, le sondage ou le formulaire.
      {/if}
    </p>
  </div>

  <div class="p-4 sm:p-5">
    <!-- Association selectors (linked event + payment) for association posts. -->
    {#if post.associationId}
      <div class="mb-5 grid gap-4 sm:grid-cols-2">
        <!-- Link to a validated event. -->
        <div class="sm:col-span-2">
          <label
            for="edit-post-linked-calendar-event"
            class="text-text-muted mb-1.5 ml-1 flex items-center gap-1.5 text-[0.65rem] font-extrabold tracking-wider uppercase"
          >
            <CalendarCheck size={14} strokeWidth={2.5} class="text-amber-500" />
            Lier à un événement validé (optionnel)
          </label>
          <select
            id="edit-post-linked-calendar-event"
            bind:value={selectedLinkedCalendarEventId}
            disabled={loadingLinkableEvents}
            class="text-text-main w-full cursor-pointer appearance-none rounded-xl border border-black/5 bg-black/5 px-4 py-3 text-sm font-bold shadow-inner transition-all outline-none hover:bg-black/10 focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 disabled:opacity-60 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10"
          >
            <option value="" class="bg-white font-medium dark:bg-zinc-900">
              {loadingLinkableEvents ? 'Chargement…' : '- Aucun événement -'}
            </option>
            {#each linkableCalendarEvents as ev (ev.id)}
              <option value={ev.id} class="bg-white font-medium dark:bg-zinc-900">
                {formatLinkableEventLabel(ev)}
              </option>
            {/each}
          </select>
          <p class="text-text-muted mt-1.5 ml-1 text-[0.7rem]">
            Seuls les événements validés de l'agenda apparaissent ici.
          </p>
        </div>

        <!-- Encaissement Stripe -->
        {#if payableForPayment}
          <div class="sm:col-span-2" transition:fade={{ duration: 200 }}>
            <label
              for="edit-post-payment-association"
              class="text-text-muted mb-1.5 ml-1 flex items-center gap-1.5 text-[0.65rem] font-extrabold tracking-wider uppercase"
            >
              <CreditCard size={14} strokeWidth={2.5} class="text-amber-500" />
              Encaissement (Stripe)
            </label>
            <div class="group relative">
              <span
                class="pointer-events-none absolute top-1/2 left-3.5 z-[1] -translate-y-1/2 text-amber-500"
                aria-hidden="true"
              >
                <Building2 size={16} strokeWidth={2.5} />
              </span>
              <select
                id="edit-post-payment-association"
                bind:value={selectedPaymentAssociationId}
                class="text-text-main w-full cursor-pointer appearance-none rounded-xl border border-black/5 bg-black/5 py-3 pr-10 pl-10 text-sm font-bold shadow-inner transition-all outline-none hover:bg-black/10 focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10"
              >
                <option value="" class="bg-white font-medium dark:bg-zinc-900"
                  >{m.post_edit_no_stripe_account()}</option
                >
                {#if postAssociation}
                  <option value={postAssociation.id} class="bg-white font-medium dark:bg-zinc-900">
                    {postAssociation.name}
                  </option>
                {/if}
              </select>
              <div
                class="text-text-muted pointer-events-none absolute inset-y-0 right-3.5 flex items-center transition-colors group-focus-within:text-amber-500"
              >
                <ChevronDown size={16} strokeWidth={2.5} />
              </div>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Text area + image preview. -->
    <div
      class="relative mb-2 rounded-[1.5rem] border border-black/5 bg-black/5 p-2 shadow-inner transition-colors focus-within:bg-white/50 dark:border-white/10 dark:bg-black/40 dark:focus-within:bg-black/60"
    >
      <MarkdownComposerField
        bind:value={markdown}
        placeholder="Écrivez votre message ici…"
        minHeight="120px"
        toolbarClass="mb-1"
        editorClass="custom-scrollbar min-h-[120px] w-full max-w-full rounded-xl bg-transparent px-4 py-3.5 text-[0.95rem] sm:text-[1rem] font-medium leading-relaxed text-text-main"
      />

      <!-- Existing media + newly added media. -->
      {#if existingMedia.length > 0 || newFiles.length > 0}
        <div
          class="custom-scrollbar flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-3 pt-2 pb-3"
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
                <button
                  type="button"
                  onclick={() => removeExistingMedia(i)}
                  class="absolute top-1.5 right-1.5 rounded-full bg-black/60 p-1.5 text-white opacity-0 shadow-sm backdrop-blur-md transition-all outline-none group-hover:opacity-100 hover:scale-110 hover:bg-red-500 focus:opacity-100 focus-visible:ring-2 focus-visible:ring-red-400 active:scale-95"
                  aria-label={m.post_edit_remove_image_aria()}
                  title="Supprimer"
                >
                  <X size={14} strokeWidth={2.5} />
                </button>
              </div>
              {#if mediaItem.caption}
                <p
                  class="text-text-muted w-full truncate rounded-lg px-2.5 py-1.5 text-[0.7rem] font-semibold"
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
                      class="w-full truncate px-2 text-center text-[0.55rem] font-bold tracking-wider uppercase"
                    >
                      {file.type.split('/')[1] ?? 'file'}
                    </span>
                  </div>
                {:else}
                  <img
                    src={newFilePreviews[i]}
                    alt="Aperçu"
                    class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                {/if}
                <button
                  type="button"
                  onclick={() => removeNewFile(i)}
                  class="absolute top-1.5 right-1.5 rounded-full bg-black/60 p-1.5 text-white opacity-0 shadow-sm backdrop-blur-md transition-all outline-none group-hover:opacity-100 hover:scale-110 hover:bg-red-500 focus:opacity-100 focus-visible:ring-2 focus-visible:ring-red-400 active:scale-95"
                  aria-label={m.post_edit_remove_image_aria()}
                  title="Supprimer"
                >
                  <X size={14} strokeWidth={2.5} />
                </button>
              </div>
              <input
                type="text"
                bind:value={newMediaCaptions[i]}
                placeholder={m.post_edit_caption_placeholder()}
                maxlength="120"
                class="text-text-main placeholder:text-text-muted/60 w-full rounded-lg border border-black/10 bg-white/70 px-2.5 py-1.5 text-[0.7rem] font-semibold shadow-inner transition-all outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500/30 dark:border-white/10 dark:bg-black/40"
              />
            </div>
          {/each}
        </div>
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
          bind:optionsRaw={pollOptionsRaw}
          bind:multipleChoice={pollMultipleChoice}
          onRemove={() => {
            includePoll = false;
            existingPollId = '';
          }}
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
          onBeforeCreateForm={() => {}}
          onRemove={() => (includeForm = false)}
        />
      </div>
    {/if}

    <!-- Bannière d'erreur -->
    {#if errorMessage}
      <div
        transition:slide={{ duration: 200 }}
        class="flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-red-600 shadow-inner dark:text-red-400"
      >
        <CircleAlert size={18} strokeWidth={2.5} class="mt-0.5 shrink-0" />
        <span class="text-sm leading-snug font-bold">{errorMessage}</span>
      </div>
    {/if}

    <!-- Barre d'outils + boutons -->
    <div class="flex flex-col-reverse gap-4 pt-1 sm:flex-row sm:items-center sm:justify-between">
      <!-- Toolbar -->
      <div
        class="custom-scrollbar flex w-full flex-wrap items-center gap-2 overflow-x-auto rounded-[1.25rem] border border-black/5 bg-white/50 p-1.5 shadow-inner sm:w-auto dark:border-white/5 dark:bg-black/20"
      >
        <!-- Add media. -->
        <label
          for={mediaInputId}
          title="Médias"
          class="text-text-muted flex shrink-0 cursor-pointer items-center gap-2 rounded-xl px-3 py-2 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95
          {newFiles.length > 0
            ? 'bg-amber-500/15 font-bold text-amber-600 shadow-sm dark:text-amber-400'
            : 'hover:text-text-main hover:bg-black/5 dark:hover:bg-white/10'}"
        >
          {#if newFiles.length > 0 && newFiles.every((f) => f.type.startsWith('image/'))}
            <Image size={18} strokeWidth={2.5} />
          {:else if newFiles.length > 0 && newFiles.every((f) => f.type.startsWith('video/'))}
            <Film size={18} strokeWidth={2.5} />
          {:else if newFiles.length > 0 && newFiles.every((f) => f.type.startsWith('audio/'))}
            <Music size={18} strokeWidth={2.5} />
          {:else}
            <FileText size={18} strokeWidth={newFiles.length > 0 ? 2.5 : 2} />
          {/if}
          <span class="hidden text-xs sm:inline">Médias</span>
        </label>
        <input
          id={mediaInputId}
          type="file"
          accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.odt,.xls,.xlsx,.ods,.ppt,.pptx,.odp,.txt,.rtf,.zip,.epub"
          multiple
          onchange={onPickFiles}
          class="sr-only"
        />

        <!-- Sondage -->
        <button
          type="button"
          title="Sondage"
          onclick={() => (includePoll = !includePoll)}
          class="text-text-muted flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95
          {includePoll
            ? 'bg-amber-500/15 font-bold text-amber-600 shadow-sm dark:text-amber-400'
            : 'hover:text-text-main hover:bg-black/5 dark:hover:bg-white/10'}"
        >
          <ChartColumn size={18} strokeWidth={includePoll ? 2.5 : 2} />
          <span class="hidden text-xs sm:inline">Sondage</span>
        </button>

        <!-- Formulaire -->
        <button
          type="button"
          title="Formulaire"
          onclick={() => (includeForm = !includeForm)}
          class="text-text-muted flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95
          {includeForm
            ? 'bg-amber-500/15 font-bold text-amber-600 shadow-sm dark:text-amber-400'
            : 'hover:text-text-main hover:bg-black/5 dark:hover:bg-white/10'}"
        >
          <ClipboardList size={18} strokeWidth={includeForm ? 2.5 : 2} />
          <span class="hidden text-xs sm:inline">Formulaire</span>
        </button>

        <!-- Séparateur -->
        <div class="mx-0.5 hidden h-6 w-px shrink-0 bg-black/10 sm:block dark:bg-white/10"></div>

        <!-- Programmation -->
        <div
          class="relative flex shrink-0 items-center rounded-xl bg-black/5 px-2 py-1.5 transition-all focus-within:ring-2 focus-within:ring-amber-500/50 dark:bg-white/5 {scheduledAt
            ? 'border border-amber-500/20 bg-amber-500/10'
            : ''}"
        >
          <Clock
            size={16}
            strokeWidth={2.5}
            class="text-text-muted ml-1 {scheduledAt ? 'text-amber-600 dark:text-amber-400' : ''}"
          />
          <input
            type="datetime-local"
            bind:value={scheduledAt}
            min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
            title={m.post_edit_schedule_title()}
            class="text-text-main cursor-pointer bg-transparent pr-1 pl-2 text-[0.7rem] font-bold outline-none {scheduledAt
              ? 'w-36 text-amber-700 dark:text-amber-400'
              : 'sm:text-text-main w-5 text-transparent sm:w-28'} transition-all"
          />
          {#if scheduledAt}
            <button
              type="button"
              onclick={() => (scheduledAt = '')}
              class="text-text-muted rounded-full p-1 transition-colors outline-none hover:bg-red-500/10 hover:text-red-500"
              title={m.post_edit_cancel_schedule_title()}
            >
              <X size={14} strokeWidth={2.5} />
            </button>
          {/if}
        </div>
      </div>

      <!-- Boutons Annuler / Enregistrer -->
      <div class="flex shrink-0 items-center gap-3">
        <button
          type="button"
          onclick={onCancel}
          class="text-text-muted hover:text-text-main rounded-xl px-4 py-2.5 text-sm font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
        >
          {m.common_cancel_button()}
        </button>
        <Button
          type="button"
          class="min-w-[9rem] px-7 py-3 text-sm !font-extrabold shadow-md shadow-amber-500/20 active:translate-y-0"
          disabled={saving ||
            (!markdown.trim() && existingMedia.length === 0 && newFiles.length === 0)}
          loading={saving}
          onclick={submitEdit}
        >
          {saving ? m.common_saving_label() : m.post_edit_save_button()}
        </Button>
      </div>
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

  input[type='datetime-local']::-webkit-calendar-picker-indicator {
    cursor: pointer;
    opacity: 0;
    position: absolute;
    left: 0;
    width: 100%;
    height: 100%;
  }
</style>
