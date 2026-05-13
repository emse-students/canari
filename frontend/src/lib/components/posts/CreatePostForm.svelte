<script lang="ts">
  import { Image, ChartColumn, CalendarCheck, ClipboardList, Clock, X, CircleAlert, Building2, User, ChevronDown } from 'lucide-svelte';
  import { slide, fade } from 'svelte/transition';
  import { onMount } from 'svelte';
  import { MediaService, compressImage } from '$lib/media';
  import { getToken } from '$lib/stores/auth';
  import { createPost, type CreatePostPayload } from '$lib/posts/api';
  import { getForms, type Form } from '$lib/forms/api';
  import { listAssociations, listMyAssociations, type Association } from '$lib/associations/api';
  import { isGlobalAdmin } from '$lib/stores/user';
  import PollSection from './PollSection.svelte';
  import EventButtonSection from './EventButtonSection.svelte';
  import FormSection from './FormSection.svelte';
  import Button from '$lib/components/ui/Button.svelte';

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

  let includeEventButton = $state(false);
  let eventLabel = $state("S'inscrire");
  let eventId = $state('');
  let eventRequiresPayment = $state(false);
  let eventAmount = $state<number>(25);
  let eventCurrency = $state('eur');
  let eventCapacity = $state<number>(100);
  let eventFormId = $state('');

  let includeForm = $state(false);
  let selectedFormId = $state('');
  let availableForms = $state<Form[]>([]);

  // --- Scheduled publication ---
  let scheduledAt = $state('');

  // --- Association identity ---
  let myAssociations = $state<Association[]>([]);
  let selectedAssociationId = $state('');
  let selectedPaymentAssociationId = $state('');

  /** Associations the user may post as (admin/owner). Global admins can post as any. */
  let postAsAssociations = $derived(
    isGlobalAdmin()
      ? myAssociations
      : myAssociations.filter((a) => a.role === 'admin' || a.role === 'owner' || a.permission === 1)
  );
  /** Associations with completed Stripe onboarding (eligible for payment collection). */
  let payableAssociations = $derived(postAsAssociations.filter((a) => a.stripeOnboardingComplete));

  // --- UI state ---
  let publishing = $state(false);
  let errorMessage = $state('');
  let authToken = $state('');

  // --- Draft auto-save ---
  const DRAFT_KEY = 'canari_post_draft';
  let draftRestored = $state(false);
  let draftSaved = $state(false);
  let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Debounced draft save: writes to localStorage 800 ms after the user stops typing. */
  $effect(() => {
    const text = markdown;
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => {
      if (text.trim()) {
        localStorage.setItem(DRAFT_KEY, text);
        draftSaved = true;
        setTimeout(() => { draftSaved = false; }, 1800);
      } else {
        localStorage.removeItem(DRAFT_KEY);
      }
    }, 800);
  });

  /** Auto-clear error banner after 5 seconds. */
  $effect(() => {
    if (errorMessage) {
      const timer = setTimeout(() => { errorMessage = ''; }, 5000);
      return () => clearTimeout(timer);
    }
  });

  const mediaService = new MediaService();
  const imageInputId = 'create-post-images-input';

  onMount(async () => {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved) { markdown = saved; draftRestored = true; }

    try { authToken = await getToken(); } catch { /* retried on upload */ }
    try { availableForms = await getForms(); } catch (e) { console.error('Failed to load forms', e); }
    try {
      myAssociations = isGlobalAdmin() ? await listAssociations() : await listMyAssociations();
    } catch (e) { console.error('Failed to load associations', e); }
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
      if (!markdown.trim() && selectedFiles.length === 0) {
        throw new Error('Le contenu du post ou une image est requis.');
      }
      if (selectedFiles.length > 0 && !authToken) {
        try { authToken = await getToken(); }
        catch { throw new Error("Impossible d'obtenir un jeton pour l'envoi d'images."); }
      }

      // Compress then encrypt-upload each image; collect the resulting refs.
      // Max 1440px on either side, WebP at 82% quality (Signal/Instagram range).
      const images = [];
      for (let i = 0; i < selectedFiles.length; i++) {
        const compressed = await compressImage(selectedFiles[i], 1440, 1440, 0.82);
        const ref = await mediaService.encryptAndUpload(compressed, authToken);
        const caption = imageCaptions[i]?.trim();
        images.push({ ...ref, ...(caption ? { caption } : {}) });
      }

      const payload: CreatePostPayload = {
        markdown,
        images,
        ...(scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
      };

      if (includePoll) {
        const options = pollOptionsRaw.split('\n').map((l) => l.trim()).filter(Boolean).map((label) => ({ label }));
        if (!pollQuestion.trim() || options.length < 2) {
          throw new Error('Un sondage nécessite une question et au moins deux options.');
        }
        payload.polls = [{ question: pollQuestion.trim(), options, multipleChoice: pollMultipleChoice }];
      }

      if (includeEventButton) {
        if (!eventLabel.trim() || !eventId.trim()) {
          throw new Error("Le libellé et l'identifiant de l'événement sont requis.");
        }
        payload.eventButtons = [{
          label: eventLabel.trim(),
          eventId: eventId.trim(),
          requiresPayment: eventRequiresPayment,
          amountCents: eventRequiresPayment ? Math.round(Number(eventAmount) * 100) : undefined,
          currency: eventRequiresPayment ? eventCurrency.toLowerCase() : undefined,
          capacity: Number(eventCapacity),
          formId: eventFormId || undefined,
        }];
      }

      if (includeForm && !includeEventButton) {
        if (!selectedFormId) throw new Error('Veuillez sélectionner un formulaire.');
        payload.attachedFormId = selectedFormId;
      }

      if (selectedAssociationId) payload.associationId = selectedAssociationId;
      if (selectedPaymentAssociationId) payload.paymentAssociationId = selectedPaymentAssociationId;

      await createPost(payload);

      // Reset all state after successful creation
      localStorage.removeItem(DRAFT_KEY);
      draftRestored = false;
      markdown = '';
      filePreviews.forEach((url) => URL.revokeObjectURL(url));
      selectedFiles = []; filePreviews = []; imageCaptions = [];
      includePoll = false; pollQuestion = ''; pollOptionsRaw = 'Oui\nNon';
      includeEventButton = false;
      includeForm = false;
      scheduledAt = '';
      onPostCreated();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Impossible de publier le post';
    } finally {
      publishing = false;
    }
  }

  // Tailwind class constants for the association selects
  const selectClass =
    'w-full appearance-none rounded-xl border border-cn-border/70 bg-cn-surface/95 dark:bg-cn-dark/50 pl-11 pr-10 py-3 text-sm font-semibold text-text-main shadow-sm transition-all outline-none focus:border-cn-yellow focus:ring-2 focus:ring-cn-yellow/25 hover:border-cn-border';
  const chevronWrapClass =
    'pointer-events-none absolute inset-y-0 right-3 flex items-center text-text-muted';
</script>

<article
  class="relative mb-6 overflow-hidden rounded-3xl border border-cn-border/70 bg-[var(--surface-elevated)] shadow-sm backdrop-blur-xl transition-shadow duration-300 focus-within:shadow-md focus-within:ring-1 focus-within:ring-cn-yellow/20 dark:border-cn-border/80 dark:bg-[color-mix(in_srgb,var(--cn-surface)_88%,transparent)]"
>
  <!-- Form header -->
  <div class="border-b border-cn-border/50 bg-cn-surface/40 px-4 py-3 dark:bg-black/15 sm:px-5">
    <p class="text-xs font-bold uppercase tracking-[0.12em] text-text-muted">Publication</p>
    <p class="mt-0.5 text-sm font-semibold text-text-main">
      Rédigez votre message — ajoutez des images, un sondage ou un bouton d'événement ci-dessous.
    </p>
  </div>

  <div class="p-4 sm:p-5">
    <!-- Association identity selector (only shown when the user manages at least one asso) -->
    {#if postAsAssociations.length > 0}
      <div class="mb-5 grid gap-4 sm:grid-cols-2">
        <!-- "Post as" selector -->
        <div>
          <label
            for="post-association-select"
            class="mb-2 flex items-center gap-2 text-[0.7rem] font-bold uppercase tracking-wider text-text-muted"
          >
            <User size={14} class="opacity-70" aria-hidden="true" />
            Publier en tant que
          </label>
          <div class="relative">
            <span class="pointer-events-none absolute left-3 top-1/2 z-[1] -translate-y-1/2 text-text-muted" aria-hidden="true">
              {#if selectedAssociationId}<Building2 size={18} strokeWidth={2.2} />{:else}<User size={18} strokeWidth={2.2} />{/if}
            </span>
            <select id="post-association-select" bind:value={selectedAssociationId} class={selectClass}>
              <option value="">Profil personnel</option>
              {#each postAsAssociations as a (a.id)}
                <option value={a.id}>{a.name}</option>
              {/each}
            </select>
            <div class={chevronWrapClass}><ChevronDown size={18} strokeWidth={2} /></div>
          </div>
        </div>

        <!-- Stripe payment association (only shown when posting as an asso) -->
        {#if payableAssociations.length > 0 && selectedAssociationId}
          <div transition:fade={{ duration: 200 }}>
            <label
              for="post-payment-association-select"
              class="mb-2 flex items-center gap-2 text-[0.7rem] font-bold uppercase tracking-wider text-text-muted"
            >
              Encaissement (Stripe)
            </label>
            <div class="relative">
              <span class="pointer-events-none absolute left-3 top-1/2 z-[1] -translate-y-1/2 text-cn-yellow" aria-hidden="true">
                <Building2 size={18} strokeWidth={2.2} />
              </span>
              <select id="post-payment-association-select" bind:value={selectedPaymentAssociationId} class={selectClass}>
                <option value="">Aucun compte lié</option>
                {#each payableAssociations as a (a.id)}
                  <option value={a.id}>{a.name}</option>
                {/each}
              </select>
              <div class={chevronWrapClass}><ChevronDown size={18} strokeWidth={2} /></div>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Draft restored banner -->
    {#if draftRestored}
      <div
        class="mb-3 flex items-center justify-between rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[0.72rem] font-bold text-amber-700 dark:text-amber-400"
        transition:slide={{ duration: 200 }}
      >
        <span>Brouillon restauré</span>
        <button
          type="button"
          onclick={() => { markdown = ''; localStorage.removeItem(DRAFT_KEY); draftRestored = false; }}
          class="opacity-70 transition-opacity hover:opacity-100 hover:underline"
        >
          Effacer
        </button>
      </div>
    {/if}

    <!-- Text area -->
    <div class="relative rounded-2xl border border-cn-border/50 bg-cn-surface/60 p-1 shadow-inner dark:border-cn-border/50 dark:bg-cn-dark/40">
      {#if draftSaved}
        <span
          class="pointer-events-none absolute right-3 top-2 text-[0.6rem] font-bold text-text-muted opacity-60"
          transition:fade={{ duration: 200 }}
        >
          Brouillon sauvegardé
        </span>
      {/if}
      <textarea
        bind:value={markdown}
        placeholder="Votre texte (markdown supporté)…"
        rows={5}
        class="custom-scrollbar min-h-[120px] w-full resize-none rounded-xl bg-transparent px-4 py-3.5 text-[1rem] font-medium leading-relaxed text-text-main placeholder:text-text-muted/55 outline-none"
      ></textarea>

      <!-- Image previews with caption inputs -->
      {#if filePreviews.length > 0}
        <div
          class="flex snap-x snap-mandatory gap-2 overflow-x-auto px-3 pb-3 pt-1"
          transition:slide={{ duration: 200 }}
          role="list"
        >
          {#each filePreviews as src, i (src)}
            <div class="flex w-[88px] shrink-0 snap-start flex-col gap-1.5 sm:w-[100px]" role="listitem">
              <div class="relative aspect-square w-full overflow-hidden rounded-xl border border-cn-border/50 shadow-sm">
                <img {src} alt="" class="h-full w-full object-cover" />
                <button
                  type="button"
                  onclick={() => removeFile(i)}
                  class="absolute right-1 top-1 rounded-full bg-black/65 p-1.5 text-white shadow backdrop-blur-sm transition hover:bg-red-500 focus-visible:outline focus-visible:ring-2 focus-visible:ring-red-400"
                  aria-label="Retirer cette image"
                >
                  <X size={14} strokeWidth={2.5} />
                </button>
              </div>
              <input
                type="text"
                bind:value={imageCaptions[i]}
                placeholder="Légende…"
                maxlength="120"
                class="w-full rounded-lg border border-cn-border/40 bg-cn-surface/70 px-2 py-1 text-[0.65rem] font-medium text-text-main placeholder:text-text-muted/60 outline-none focus:border-cn-yellow focus:ring-1 focus:ring-cn-yellow/30"
              />
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Optional sections + toolbar + publish button -->
  <div class="space-y-4 border-t border-cn-border/50 px-4 pb-5 pt-4 sm:px-5">
    <!-- Poll configuration card -->
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

    <!-- Event button configuration card -->
    {#if includeEventButton}
      <div transition:slide={{ duration: 300, easing: (t) => t * (2 - t) }}>
        <EventButtonSection
          bind:label={eventLabel}
          bind:eventId={eventId}
          bind:requiresPayment={eventRequiresPayment}
          bind:amount={eventAmount}
          bind:currency={eventCurrency}
          bind:capacity={eventCapacity}
          bind:formId={eventFormId}
          {availableForms}
          onRemove={() => (includeEventButton = false)}
        />
      </div>
    {/if}

    <!-- Standalone form attachment card (mutually exclusive with event button) -->
    {#if includeForm && !includeEventButton}
      <div transition:slide={{ duration: 300, easing: (t) => t * (2 - t) }}>
        <FormSection
          bind:selectedFormId
          {availableForms}
          onRemove={() => (includeForm = false)}
        />
      </div>
    {/if}

    <!-- Error banner -->
    {#if errorMessage}
      <div
        transition:slide={{ duration: 200 }}
        class="flex items-start gap-3 rounded-xl border border-red-500/25 bg-red-500/10 p-3.5 text-red-600 shadow-inner dark:text-red-400"
      >
        <CircleAlert size={18} class="mt-0.5 shrink-0" />
        <span class="text-sm font-bold leading-snug">{errorMessage}</span>
      </div>
    {/if}

    <!-- Toolbar (attachment toggles) + publish button -->
    <div class="flex flex-col-reverse gap-4 border-t border-cn-border/40 pt-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="custom-scrollbar flex flex-wrap items-stretch gap-2 overflow-x-auto rounded-2xl bg-cn-surface/50 p-1.5 ring-1 ring-cn-border/40 dark:bg-black/20">
        <!-- Image picker -->
        <label
          for={imageInputId}
          title="Photos"
          class="flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-text-muted transition-all outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow active:scale-[0.98] sm:px-3 {selectedFiles.length > 0 ? 'bg-cn-yellow/20 font-semibold text-cn-dark dark:text-cn-yellow' : 'hover:bg-cn-border/40 hover:text-text-main'}"
        >
          <Image size={20} strokeWidth={selectedFiles.length > 0 ? 2.5 : 2} />
          <span class="hidden text-xs font-semibold sm:inline">Photos</span>
        </label>
        <input id={imageInputId} type="file" accept="image/*" multiple onchange={onPickFiles} class="sr-only" />

        <!-- Poll toggle -->
        <button
          type="button" title="Sondage"
          onclick={() => (includePoll = !includePoll)}
          class="flex items-center gap-2 rounded-xl px-2.5 py-2 text-text-muted transition-all outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow active:scale-[0.98] sm:px-3 {includePoll ? 'bg-cn-yellow/20 font-semibold text-cn-dark dark:text-cn-yellow' : 'hover:bg-cn-border/40 hover:text-text-main'}"
        >
          <ChartColumn size={20} strokeWidth={includePoll ? 2.5 : 2} />
          <span class="hidden text-xs font-semibold sm:inline">Sondage</span>
        </button>

        <!-- Event button toggle -->
        <button
          type="button" title="Événement"
          onclick={() => { includeEventButton = !includeEventButton; if (includeEventButton) includeForm = false; }}
          class="flex items-center gap-2 rounded-xl px-2.5 py-2 text-text-muted transition-all outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow active:scale-[0.98] sm:px-3 {includeEventButton ? 'bg-cn-yellow/20 font-semibold text-cn-dark dark:text-cn-yellow' : 'hover:bg-cn-border/40 hover:text-text-main'}"
        >
          <CalendarCheck size={20} strokeWidth={includeEventButton ? 2.5 : 2} />
          <span class="hidden text-xs font-semibold sm:inline">Événement</span>
        </button>

        <!-- Form toggle (hidden when event button is active) -->
        {#if !includeEventButton}
          <button
            type="button" title="Formulaire"
            onclick={() => (includeForm = !includeForm)}
            class="flex items-center gap-2 rounded-xl px-2.5 py-2 text-text-muted transition-all outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow active:scale-[0.98] sm:px-3 {includeForm ? 'bg-cn-yellow/20 font-semibold text-cn-dark dark:text-cn-yellow' : 'hover:bg-cn-border/40 hover:text-text-main'}"
          >
            <ClipboardList size={20} strokeWidth={includeForm ? 2.5 : 2} />
            <span class="hidden text-xs font-semibold sm:inline">Formulaire</span>
          </button>
        {/if}

        <!-- Scheduled date picker -->
        <div class="flex items-center gap-1.5">
          <button
            type="button"
            title={scheduledAt ? 'Modifier la programmation' : 'Programmer la publication'}
            class="flex items-center gap-2 rounded-xl px-2.5 py-2 text-text-muted transition-all outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow active:scale-[0.98] sm:px-3 {scheduledAt ? 'bg-cn-yellow/20 font-semibold text-cn-dark dark:text-cn-yellow' : 'hover:bg-cn-border/40 hover:text-text-main'}"
          >
            <Clock size={20} strokeWidth={scheduledAt ? 2.5 : 2} />
            <span class="hidden text-xs font-semibold sm:inline">Programmer</span>
          </button>
          <input
            type="datetime-local"
            bind:value={scheduledAt}
            min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
            class="rounded-xl border border-cn-border/60 bg-cn-surface/70 px-2 py-1.5 text-xs font-medium text-text-main outline-none focus:border-cn-yellow focus:ring-1 focus:ring-cn-yellow/30 {scheduledAt ? 'w-44' : 'w-32'}"
          />
          {#if scheduledAt}
            <button
              type="button"
              onclick={() => (scheduledAt = '')}
              class="rounded-full p-1 text-text-muted transition-colors hover:text-red-500"
              title="Annuler la programmation"
              aria-label="Annuler"
            >
              <X size={14} />
            </button>
          {/if}
        </div>
      </div>

      <!-- Publish / Schedule button -->
      <Button
        type="button"
        class="min-w-[9rem] shrink-0 px-8 py-2.5 text-sm !font-extrabold sm:w-auto"
        disabled={publishing || (!markdown.trim() && selectedFiles.length === 0)}
        loading={publishing}
        onclick={publishPost}
      >
        {#if publishing}
          {scheduledAt ? 'Programmation…' : 'Publication…'}
        {:else}
          {scheduledAt ? 'Programmer' : 'Publier'}
        {/if}
      </Button>
    </div>
  </div>
</article>

<style>
  .custom-scrollbar::-webkit-scrollbar { width: 4px; height: 4px; }
  .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
  .custom-scrollbar::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--cn-surface) 20%, transparent);
    border-radius: 4px;
  }
  :global([data-theme='dark']) .custom-scrollbar::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.15);
  }
</style>
