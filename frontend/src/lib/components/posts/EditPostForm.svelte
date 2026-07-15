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
    type PostImageRef,
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
  import PostImage from './PostImage.svelte';
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

  // --- Images ---
  // Existing images already uploaded: show with PostImage, removable.
  let existingImages = $state<PostImageRef[]>(untrack(() => [...(post.images ?? [])]));
  // New files chosen locally (not yet uploaded).
  let newFiles = $state<File[]>([]);
  let newFilePreviews = $state<string[]>([]);
  let newImageCaptions = $state<string[]>([]);

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
  const imageInputId = 'edit-post-images-input';

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

  /** Appends newly picked files to the new-files list. */
  function onPickFiles(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []).filter((f) => f.type.startsWith('image/'));
    newFiles = [...newFiles, ...files];
    newFilePreviews = [...newFilePreviews, ...files.map((f) => URL.createObjectURL(f))];
    newImageCaptions = [...newImageCaptions, ...files.map(() => '')];
    // Reset input so the same file can be picked again.
    input.value = '';
  }

  /** Removes an existing image (already uploaded) by index. */
  function removeExistingImage(i: number) {
    existingImages = existingImages.filter((_, idx) => idx !== i);
  }

  /** Removes a newly picked (not yet uploaded) image by index. */
  function removeNewFile(i: number) {
    URL.revokeObjectURL(newFilePreviews[i]);
    newFiles = newFiles.filter((_, idx) => idx !== i);
    newFilePreviews = newFilePreviews.filter((_, idx) => idx !== i);
    newImageCaptions = newImageCaptions.filter((_, idx) => idx !== i);
  }

  async function submitEdit() {
    saving = true;
    errorMessage = '';
    try {
      markdown = trimComposerText(markdown);
      if (!markdown.trim() && existingImages.length === 0 && newFiles.length === 0) {
        throw new Error('Post content or an image is required.');
      }

      if (newFiles.length > 0 && !currentAuthToken) {
        try {
          currentAuthToken = await getToken();
        } catch {
          throw new Error('Failed to obtain an auth token for image upload.');
        }
      }

      // Upload new images and get their refs.
      const uploadedRefs: PostImageRef[] = [];
      for (let i = 0; i < newFiles.length; i++) {
        const { maxWidth, maxHeight, quality } = IMAGE_COMPRESS_PRESETS.post;
        const compressed = await compressImage(newFiles[i], maxWidth, maxHeight, quality);
        const ref = await mediaService.encryptAndUpload(compressed.file, currentAuthToken, {
          width: compressed.width,
          height: compressed.height,
        });
        const caption = newImageCaptions[i]?.trim();
        uploadedRefs.push({ ...ref, ...(caption ? { caption } : {}) });
      }

      const allImages = [...existingImages, ...uploadedRefs];

      const payload: UpdatePostPayload = {
        markdown,
        images: allImages,
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
  class="relative overflow-hidden rounded-[2rem] border border-black/5 dark:border-white/10 bg-white/70 dark:bg-[#151B2C]/70 shadow-sm backdrop-blur-2xl transition-all duration-300 focus-within:shadow-lg focus-within:border-amber-500/30"
>
  <!-- En-tête -->
  <div class="border-b border-black/5 dark:border-white/10 bg-white/40 dark:bg-black/20 px-5 py-4">
    <p class="text-[0.65rem] font-extrabold uppercase tracking-widest text-amber-500 mb-0.5">
      Modifier la publication
    </p>
    <p class="text-sm font-semibold text-text-main opacity-90">
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
            class="mb-1.5 flex items-center gap-1.5 text-[0.65rem] font-extrabold uppercase tracking-wider text-text-muted ml-1"
          >
            <CalendarCheck size={14} strokeWidth={2.5} class="text-amber-500" />
            Lier à un événement validé (optionnel)
          </label>
          <select
            id="edit-post-linked-calendar-event"
            bind:value={selectedLinkedCalendarEventId}
            disabled={loadingLinkableEvents}
            class="w-full appearance-none rounded-xl border border-black/5 dark:border-white/10 bg-black/5 dark:bg-white/5 px-4 py-3 text-sm font-bold text-text-main shadow-inner transition-all outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer disabled:opacity-60"
          >
            <option value="" class="bg-white dark:bg-zinc-900 font-medium">
              {loadingLinkableEvents ? 'Chargement…' : '- Aucun événement -'}
            </option>
            {#each linkableCalendarEvents as ev (ev.id)}
              <option value={ev.id} class="bg-white dark:bg-zinc-900 font-medium">
                {formatLinkableEventLabel(ev)}
              </option>
            {/each}
          </select>
          <p class="mt-1.5 text-[0.7rem] text-text-muted ml-1">
            Seuls les événements validés de l'agenda apparaissent ici.
          </p>
        </div>

        <!-- Encaissement Stripe -->
        {#if payableForPayment}
          <div class="sm:col-span-2" transition:fade={{ duration: 200 }}>
            <label
              for="edit-post-payment-association"
              class="mb-1.5 flex items-center gap-1.5 text-[0.65rem] font-extrabold uppercase tracking-wider text-text-muted ml-1"
            >
              <CreditCard size={14} strokeWidth={2.5} class="text-amber-500" />
              Encaissement (Stripe)
            </label>
            <div class="relative group">
              <span
                class="pointer-events-none absolute left-3.5 top-1/2 z-[1] -translate-y-1/2 text-amber-500"
                aria-hidden="true"
              >
                <Building2 size={16} strokeWidth={2.5} />
              </span>
              <select
                id="edit-post-payment-association"
                bind:value={selectedPaymentAssociationId}
                class="w-full appearance-none rounded-xl border border-black/5 dark:border-white/10 bg-black/5 dark:bg-white/5 pl-10 pr-10 py-3 text-sm font-bold text-text-main shadow-inner transition-all outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer"
              >
                <option value="" class="bg-white dark:bg-zinc-900 font-medium"
                  >{m.post_edit_no_stripe_account()}</option
                >
                {#if postAssociation}
                  <option value={postAssociation.id} class="bg-white dark:bg-zinc-900 font-medium">
                    {postAssociation.name}
                  </option>
                {/if}
              </select>
              <div
                class="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-text-muted group-focus-within:text-amber-500 transition-colors"
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
      class="relative rounded-[1.5rem] border border-black/5 dark:border-white/10 bg-black/5 dark:bg-black/40 shadow-inner p-2 mb-2 transition-colors focus-within:bg-white/50 dark:focus-within:bg-black/60"
    >
      <MarkdownComposerField
        bind:value={markdown}
        placeholder="Écrivez votre message ici…"
        minHeight="120px"
        toolbarClass="mb-1"
        editorClass="custom-scrollbar min-h-[120px] w-full max-w-full rounded-xl bg-transparent px-4 py-3.5 text-[0.95rem] sm:text-[1rem] font-medium leading-relaxed text-text-main"
      />

      <!-- Existing images + newly added images. -->
      {#if existingImages.length > 0 || newFilePreviews.length > 0}
        <div
          class="flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-3 pb-3 pt-2 custom-scrollbar"
          transition:slide={{ duration: 200 }}
          role="list"
        >
          <!-- Images existantes (déjà uploadées) -->
          {#each existingImages as img, i (img.mediaId)}
            <div
              class="flex w-[100px] shrink-0 snap-start flex-col gap-2 sm:w-[120px]"
              role="listitem"
            >
              <div
                class="relative aspect-square w-full overflow-hidden rounded-2xl border border-black/10 dark:border-white/10 shadow-sm group"
              >
                <PostImage media={img} authToken={currentAuthToken} />
                <button
                  type="button"
                  onclick={() => removeExistingImage(i)}
                  class="absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1.5 text-white shadow-sm backdrop-blur-md transition-all hover:bg-red-500 hover:scale-110 active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-red-400 opacity-0 group-hover:opacity-100 focus:opacity-100"
                  aria-label={m.post_edit_remove_image_aria()}
                  title="Supprimer"
                >
                  <X size={14} strokeWidth={2.5} />
                </button>
              </div>
              {#if img.caption}
                <p
                  class="w-full rounded-lg px-2.5 py-1.5 text-[0.7rem] font-semibold text-text-muted truncate"
                  title={img.caption}
                >
                  {img.caption}
                </p>
              {/if}
            </div>
          {/each}

          <!-- New images (local, not yet uploaded). -->
          {#each newFilePreviews as src, i (src)}
            <div
              class="flex w-[100px] shrink-0 snap-start flex-col gap-2 sm:w-[120px]"
              role="listitem"
            >
              <div
                class="relative aspect-square w-full overflow-hidden rounded-2xl border border-black/10 dark:border-white/10 shadow-sm group"
              >
                <img
                  {src}
                  alt="Aperçu"
                  class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                />
                <button
                  type="button"
                  onclick={() => removeNewFile(i)}
                  class="absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1.5 text-white shadow-sm backdrop-blur-md transition-all hover:bg-red-500 hover:scale-110 active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-red-400 opacity-0 group-hover:opacity-100 focus:opacity-100"
                  aria-label={m.post_edit_remove_image_aria()}
                  title="Supprimer"
                >
                  <X size={14} strokeWidth={2.5} />
                </button>
              </div>
              <input
                type="text"
                bind:value={newImageCaptions[i]}
                placeholder={m.post_edit_caption_placeholder()}
                maxlength="120"
                class="w-full rounded-lg border border-black/10 dark:border-white/10 bg-white/70 dark:bg-black/40 px-2.5 py-1.5 text-[0.7rem] font-semibold text-text-main placeholder:text-text-muted/60 outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500/30 transition-all shadow-inner"
              />
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Optional sections & footer. -->
  <div class="space-y-4 border-t border-black/5 dark:border-white/10 px-4 pb-5 pt-5 sm:px-5">
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
        class="flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-red-600 dark:text-red-400 shadow-inner"
      >
        <CircleAlert size={18} strokeWidth={2.5} class="mt-0.5 shrink-0" />
        <span class="text-sm font-bold leading-snug">{errorMessage}</span>
      </div>
    {/if}

    <!-- Barre d'outils + boutons -->
    <div class="flex flex-col-reverse gap-4 pt-1 sm:flex-row sm:items-center sm:justify-between">
      <!-- Toolbar -->
      <div
        class="custom-scrollbar flex flex-wrap items-center gap-2 overflow-x-auto rounded-[1.25rem] bg-white/50 dark:bg-black/20 p-1.5 shadow-inner border border-black/5 dark:border-white/5 w-full sm:w-auto"
      >
        <!-- Add photos. -->
        <label
          for={imageInputId}
          title="Photos"
          class="flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-text-muted transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 shrink-0
          {newFiles.length > 0
            ? 'bg-amber-500/15 font-bold text-amber-600 dark:text-amber-400 shadow-sm'
            : 'hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main'}"
        >
          <Image size={18} strokeWidth={newFiles.length > 0 ? 2.5 : 2} />
          <span class="hidden text-xs sm:inline">Photos</span>
        </label>
        <input
          id={imageInputId}
          type="file"
          accept="image/*"
          multiple
          onchange={onPickFiles}
          class="sr-only"
        />

        <!-- Sondage -->
        <button
          type="button"
          title="Sondage"
          onclick={() => (includePoll = !includePoll)}
          class="flex items-center gap-2 rounded-xl px-3 py-2 text-text-muted transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 shrink-0
          {includePoll
            ? 'bg-amber-500/15 font-bold text-amber-600 dark:text-amber-400 shadow-sm'
            : 'hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main'}"
        >
          <ChartColumn size={18} strokeWidth={includePoll ? 2.5 : 2} />
          <span class="hidden text-xs sm:inline">Sondage</span>
        </button>

        <!-- Formulaire -->
        <button
          type="button"
          title="Formulaire"
          onclick={() => (includeForm = !includeForm)}
          class="flex items-center gap-2 rounded-xl px-3 py-2 text-text-muted transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 shrink-0
          {includeForm
            ? 'bg-amber-500/15 font-bold text-amber-600 dark:text-amber-400 shadow-sm'
            : 'hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main'}"
        >
          <ClipboardList size={18} strokeWidth={includeForm ? 2.5 : 2} />
          <span class="hidden text-xs sm:inline">Formulaire</span>
        </button>

        <!-- Séparateur -->
        <div class="h-6 w-px bg-black/10 dark:bg-white/10 mx-0.5 shrink-0 hidden sm:block"></div>

        <!-- Programmation -->
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
            title={m.post_edit_schedule_title()}
            class="bg-transparent pl-2 pr-1 text-[0.7rem] font-bold text-text-main outline-none cursor-pointer {scheduledAt
              ? 'w-36 text-amber-700 dark:text-amber-400'
              : 'w-5 sm:w-28 text-transparent sm:text-text-main'} transition-all"
          />
          {#if scheduledAt}
            <button
              type="button"
              onclick={() => (scheduledAt = '')}
              class="rounded-full p-1 text-text-muted transition-colors hover:text-red-500 hover:bg-red-500/10 outline-none"
              title={m.post_edit_cancel_schedule_title()}
            >
              <X size={14} strokeWidth={2.5} />
            </button>
          {/if}
        </div>
      </div>

      <!-- Boutons Annuler / Enregistrer -->
      <div class="flex items-center gap-3 shrink-0">
        <button
          type="button"
          onclick={onCancel}
          class="px-4 py-2.5 text-sm font-bold text-text-muted hover:text-text-main rounded-xl transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
        >
          {m.common_cancel_button()}
        </button>
        <Button
          type="button"
          class="min-w-[9rem] px-7 py-3 text-sm !font-extrabold shadow-md shadow-amber-500/20 active:translate-y-0"
          disabled={saving ||
            (!markdown.trim() && existingImages.length === 0 && newFiles.length === 0)}
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
