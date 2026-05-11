<script lang="ts">
  import {
    Image,
    ChartColumn,
    CalendarCheck,
    ClipboardList,
    X,
    CircleAlert,
    Building2,
    User,
    ChevronDown,
  } from 'lucide-svelte';
  import { MediaService } from '$lib/media';
  import { getToken } from '$lib/stores/auth';
  import { createPost, type CreatePostPayload } from '$lib/posts/api';
  import { getForms, type Form } from '$lib/forms/api';
  import { listAssociations, listMyAssociations, type Association } from '$lib/associations/api';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { onMount } from 'svelte';
  import { slide, fade } from 'svelte/transition';
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import Button from '$lib/components/ui/Button.svelte';

  /** Shared styles: native selects stay accessible; chevron is decorative. */
  const selectClass =
    'w-full appearance-none rounded-xl border border-cn-border/70 bg-cn-surface/95 dark:bg-cn-dark/50 pl-11 pr-10 py-3 text-sm font-semibold text-text-main shadow-sm transition-all outline-none focus:border-cn-yellow focus:ring-2 focus:ring-cn-yellow/25 hover:border-cn-border';
  /** Same as {@link selectClass} but without leading icon padding (nested selects). */
  const selectPlainClass =
    'w-full appearance-none rounded-xl border border-cn-border/70 bg-cn-surface/95 dark:bg-cn-dark/50 px-4 pr-10 py-3 text-sm font-medium text-text-main shadow-sm transition-all outline-none focus:border-cn-yellow focus:ring-2 focus:ring-cn-yellow/25 hover:border-cn-border';
  const chevronWrapClass =
    'pointer-events-none absolute inset-y-0 right-3 flex items-center text-text-muted';
  const sectionIconClass = 'text-cn-yellow shrink-0';
  const optionCardClass =
    'rounded-2xl border border-cn-border/60 bg-cn-surface/70 dark:bg-black/25 p-5 shadow-sm ring-1 ring-black/[0.02] dark:ring-white/[0.04]';

  interface Props {
    onPostCreated: () => void;
  }

  let { onPostCreated }: Props = $props();

  let markdown = $state('');
  let selectedFiles = $state<File[]>([]);
  let filePreviews = $state<string[]>([]);

  let includePoll = $state(false);
  let pollQuestion = $state('');
  let pollOptionsRaw = $state('Oui\nNon');
  let pollMultipleChoice = $state(false);

  let includeEventButton = $state(false);
  const imageInputId = 'create-post-images-input';
  let eventLabel = $state("S'inscrire");
  let eventId = $state('');
  let eventRequiresPayment = $state(false);
  let eventAmount = $state<number>(25);
  let eventCurrency = $state('eur');
  let eventCapacity = $state<number>(100);
  let eventFormId = $state('');

  let availableForms = $state<Form[]>([]);
  let selectedFormId = $state('');
  let includeForm = $state(false);

  let myAssociations = $state<Association[]>([]);
  let selectedAssociationId = $state('');
  let selectedPaymentAssociationId = $state('');
  /** Associations the user may post as (admin/owner of membership, or any asso if global admin). */
  let postAsAssociations = $derived(
    isGlobalAdmin()
      ? myAssociations
      : myAssociations.filter(
          (a) =>
            a.role === 'admin' ||
            a.role === 'owner' ||
            a.permission === 1
        )
  );
  let payableAssociations = $derived(postAsAssociations.filter((a) => a.stripeOnboardingComplete));

  let publishing = $state(false);
  let errorMessage = $state('');
  let authToken = $state('');

  const DRAFT_KEY = 'canari_post_draft';
  let draftRestored = $state(false);
  let draftSaved = $state(false);
  let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;

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

  const mediaService = new MediaService();

  // Auto-clear de l'erreur après 5 secondes
  $effect(() => {
    if (errorMessage) {
      const timer = setTimeout(() => {
        errorMessage = '';
      }, 5000);
      return () => clearTimeout(timer);
    }
  });

  onMount(async () => {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved) {
      markdown = saved;
      draftRestored = true;
    }

    try {
      authToken = await getToken();
    } catch {
      // will retry on upload
    }
    try {
      availableForms = await getForms();
    } catch (e) {
      console.error('Failed to load forms', e);
    }
    try {
      myAssociations = isGlobalAdmin() ? await listAssociations() : await listMyAssociations();
    } catch (e) {
      console.error('Failed to load associations', e);
    }
  });

  function onPickFiles(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []).filter((f) => f.type.startsWith('image/'));
    filePreviews.forEach((url) => URL.revokeObjectURL(url));
    selectedFiles = files;
    filePreviews = files.map((f) => URL.createObjectURL(f));
  }

  function removeFile(i: number) {
    URL.revokeObjectURL(filePreviews[i]);
    selectedFiles = selectedFiles.filter((_, idx) => idx !== i);
    filePreviews = filePreviews.filter((_, idx) => idx !== i);
  }

  async function publishPost() {
    publishing = true;
    errorMessage = '';

    try {
      if (!markdown.trim() && selectedFiles.length === 0) {
        throw new Error('Le contenu du post ou une image est requis.');
      }

      if (selectedFiles.length > 0 && !authToken) {
        try {
          authToken = await getToken();
        } catch {
          throw new Error("Impossible d'obtenir un jeton pour l'envoi d'images.");
        }
      }

      const images = [];
      for (const file of selectedFiles) {
        const ref = await mediaService.encryptAndUpload(file, authToken);
        images.push({
          mediaId: ref.mediaId,
          key: ref.key,
          iv: ref.iv,
          mimeType: ref.mimeType,
          size: ref.size,
          fileName: ref.fileName,
        });
      }

      const payload: CreatePostPayload = { markdown, images };

      if (includePoll) {
        const options = pollOptionsRaw
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((label) => ({ label }));
        if (pollQuestion.trim() && options.length >= 2) {
          payload.polls = [
            { question: pollQuestion.trim(), options, multipleChoice: pollMultipleChoice },
          ];
        } else {
          throw new Error('Un sondage nécessite une question et au moins deux options.');
        }
      }

      if (includeEventButton) {
        if (!eventLabel.trim() || !eventId.trim())
          throw new Error("Le libellé et l'identifiant de l'événement sont requis.");
        payload.eventButtons = [
          {
            label: eventLabel.trim(),
            eventId: eventId.trim(),
            requiresPayment: eventRequiresPayment,
            amountCents: eventRequiresPayment ? Math.round(Number(eventAmount) * 100) : undefined,
            currency: eventRequiresPayment ? eventCurrency.toLowerCase() : undefined,
            capacity: Number(eventCapacity),
            formId: eventFormId || undefined,
          },
        ];
      }

      if (includeForm && !includeEventButton) {
        if (!selectedFormId) throw new Error('Veuillez sélectionner un formulaire.');
        payload.attachedFormId = selectedFormId;
      }

      if (selectedAssociationId) {
        payload.associationId = selectedAssociationId;
      }
      if (selectedPaymentAssociationId) {
        payload.paymentAssociationId = selectedPaymentAssociationId;
      }

      await createPost(payload);

      // Reset
      localStorage.removeItem(DRAFT_KEY);
      draftRestored = false;
      markdown = '';
      selectedFiles = [];
      filePreviews.forEach((url) => URL.revokeObjectURL(url));
      filePreviews = [];
      includePoll = false;
      pollQuestion = '';
      pollOptionsRaw = 'Oui\nNon';
      includeEventButton = false;
      includeForm = false;

      onPostCreated();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Impossible de publier le post';
    } finally {
      publishing = false;
    }
  }
</script>

<article
  class="relative mb-6 overflow-hidden rounded-3xl border border-cn-border/70 bg-[var(--surface-elevated)] shadow-sm backdrop-blur-xl transition-shadow duration-300 focus-within:shadow-md focus-within:ring-1 focus-within:ring-cn-yellow/20 dark:border-cn-border/80 dark:bg-[color-mix(in_srgb,var(--cn-surface)_88%,transparent)]"
>
  <div class="border-b border-cn-border/50 bg-cn-surface/40 px-4 py-3 dark:bg-black/15 sm:px-5">
    <p class="text-xs font-bold uppercase tracking-[0.12em] text-text-muted">Publication</p>
    <p class="mt-0.5 text-sm font-semibold text-text-main">
      Rédigez votre message — ajoutez des images, un sondage ou un bouton d’événement ci-dessous.
    </p>
  </div>

  <div class="p-4 sm:p-5">
    <!-- Identité (association / Stripe) -->
    {#if postAsAssociations.length > 0}
      <div class="mb-5 grid gap-4 sm:grid-cols-2">
        <div>
          <label
            for="post-association-select"
            class="mb-2 flex items-center gap-2 text-[0.7rem] font-bold uppercase tracking-wider text-text-muted"
          >
            <User size={14} class="opacity-70" aria-hidden="true" />
            Publier en tant que
          </label>
          <div class="relative">
            <span
              class="pointer-events-none absolute left-3 top-1/2 z-[1] -translate-y-1/2 text-text-muted"
              aria-hidden="true"
            >
              {#if selectedAssociationId}
                <Building2 size={18} strokeWidth={2.2} />
              {:else}
                <User size={18} strokeWidth={2.2} />
              {/if}
            </span>
            <select
              id="post-association-select"
              bind:value={selectedAssociationId}
              class={selectClass}
            >
              <option value="">Profil personnel</option>
              {#each postAsAssociations as a (a.id)}
                <option value={a.id}>{a.name}</option>
              {/each}
            </select>
            <div class={chevronWrapClass}>
              <ChevronDown size={18} strokeWidth={2} />
            </div>
          </div>
        </div>

        {#if payableAssociations.length > 0 && selectedAssociationId}
          <div transition:fade={{ duration: 200 }}>
            <label
              for="post-payment-association-select"
              class="mb-2 flex items-center gap-2 text-[0.7rem] font-bold uppercase tracking-wider text-text-muted"
            >
              Encaissement (Stripe)
            </label>
            <div class="relative">
              <span
                class="pointer-events-none absolute left-3 top-1/2 z-[1] -translate-y-1/2 text-cn-yellow"
                aria-hidden="true"
              >
                <Building2 size={18} strokeWidth={2.2} />
              </span>
              <select
                id="post-payment-association-select"
                bind:value={selectedPaymentAssociationId}
                class={selectClass}
              >
                <option value="">Aucun compte lié</option>
                {#each payableAssociations as a (a.id)}
                  <option value={a.id}>{a.name}</option>
                {/each}
              </select>
              <div class={chevronWrapClass}>
                <ChevronDown size={18} strokeWidth={2} />
              </div>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Zone de saisie -->
    {#if draftRestored}
      <div class="mb-3 flex items-center justify-between rounded-xl bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-[0.72rem] font-bold text-amber-700 dark:text-amber-400" transition:slide={{ duration: 200 }}>
        <span>Brouillon restauré</span>
        <button type="button" onclick={() => { markdown = ''; localStorage.removeItem(DRAFT_KEY); draftRestored = false; }} class="hover:underline opacity-70 hover:opacity-100 transition-opacity">Effacer</button>
      </div>
    {/if}
    <div
      class="relative rounded-2xl border border-cn-border/50 bg-cn-surface/60 p-1 shadow-inner dark:border-cn-border/50 dark:bg-cn-dark/40"
    >
      {#if draftSaved}
        <span class="absolute top-2 right-3 text-[0.6rem] font-bold text-text-muted opacity-60 pointer-events-none" transition:fade={{ duration: 200 }}>Brouillon sauvegardé</span>
      {/if}
      <textarea
        bind:value={markdown}
        placeholder="Votre texte (markdown supporté)…"
        rows={5}
        class="custom-scrollbar min-h-[120px] w-full resize-none rounded-xl bg-transparent px-4 py-3.5 text-[1rem] font-medium leading-relaxed text-text-main placeholder:text-text-muted/55 outline-none"
      ></textarea>

      {#if filePreviews.length > 0}
        <div
          class="flex snap-x snap-mandatory gap-2 overflow-x-auto px-3 pb-3 pt-1"
          transition:slide={{ duration: 200 }}
          role="list"
        >
          {#each filePreviews as src, i (src)}
            <div
              class="relative aspect-square w-[88px] shrink-0 snap-start overflow-hidden rounded-xl border border-cn-border/50 shadow-sm sm:w-[100px]"
              role="listitem"
            >
              <img
                {src}
                alt=""
                class="h-full w-full object-cover"
              />
              <button
                type="button"
                onclick={() => removeFile(i)}
                class="absolute right-1 top-1 rounded-full bg-black/65 p-1.5 text-white shadow backdrop-blur-sm transition hover:bg-red-500 focus-visible:outline focus-visible:ring-2 focus-visible:ring-red-400"
                aria-label="Retirer cette image"
                title="Retirer"
              >
                <X size={14} strokeWidth={2.5} />
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Options + erreur + actions -->
  <div class="space-y-4 border-t border-cn-border/50 px-4 pb-5 pt-4 sm:px-5">
    <!-- Section Sondage -->
    {#if includePoll}
      <div transition:slide={{ duration: 300, easing: (t) => t * (2 - t) }} class={optionCardClass}>
        <div class="mb-4 flex items-center justify-between gap-2">
          <p
            class="flex items-center gap-2 text-[0.75rem] font-bold uppercase tracking-widest text-text-muted"
          >
            <ChartColumn size={16} strokeWidth={2.5} class={sectionIconClass} />
            Sondage
          </p>
          <button
            type="button"
            onclick={() => (includePoll = false)}
            class="rounded-full p-1.5 text-text-muted transition-colors hover:bg-cn-surface hover:text-text-main"
            title="Retirer le sondage"
          >
            <X size={16} />
          </button>
        </div>

        <div class="space-y-4">
          <Input
            label="Question du sondage"
            bind:value={pollQuestion}
            placeholder="Quelle est votre question ?"
          />
          <Textarea label="Options (une par ligne)" bind:value={pollOptionsRaw} rows={3} />

          <label
            class="group/toggle flex cursor-pointer select-none items-center justify-between rounded-xl bg-cn-surface/80 px-4 py-3 transition-colors hover:bg-cn-border/30 dark:bg-white/5 dark:hover:bg-white/10"
          >
            <span class="text-sm font-semibold text-text-main">Autoriser plusieurs réponses</span>
            <div class="relative flex items-center">
              <input type="checkbox" bind:checked={pollMultipleChoice} class="peer sr-only" />
              <div
                class="h-6 w-11 rounded-full bg-black/15 shadow-inner transition-colors duration-300 peer-checked:bg-cn-yellow dark:bg-white/20"
              ></div>
              <div
                class="absolute left-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-300 peer-checked:translate-x-5"
              ></div>
            </div>
          </label>
        </div>
      </div>
    {/if}

    {#if includeEventButton}
      <div transition:slide={{ duration: 300, easing: (t) => t * (2 - t) }} class={optionCardClass}>
        <div class="mb-4 flex items-center justify-between gap-2">
          <p
            class="flex items-center gap-2 text-[0.75rem] font-bold uppercase tracking-widest text-text-muted"
          >
            <CalendarCheck size={16} strokeWidth={2.5} class={sectionIconClass} />
            Bouton d’événement
          </p>
          <button
            type="button"
            onclick={() => (includeEventButton = false)}
            class="rounded-full p-1.5 text-text-muted transition-colors hover:bg-cn-surface hover:text-text-main"
            title="Retirer l’événement"
          >
            <X size={16} />
          </button>
        </div>

        <div class="space-y-4">
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Libellé du bouton"
              bind:value={eventLabel}
              placeholder="Ex: S'inscrire à l'AgA"
            />
            <Input label="ID unique de l'événement" bind:value={eventId} placeholder="ex: wei-2026" />
          </div>

          <div class="grid grid-cols-1 items-end gap-4 sm:grid-cols-2">
            <Input
              type="number"
              label="Capacité max (places)"
              bind:value={eventCapacity as unknown as string}
            />

            <label
              class="flex h-[46px] cursor-pointer select-none items-center justify-between rounded-xl bg-cn-surface/80 px-4 py-3 transition-colors hover:bg-cn-border/30 dark:bg-white/5 dark:hover:bg-white/10 sm:mb-[2px]"
            >
              <span class="text-sm font-semibold text-text-main">Inscription payante</span>
              <div class="relative flex items-center">
                <input type="checkbox" bind:checked={eventRequiresPayment} class="peer sr-only" />
                <div
                  class="h-6 w-11 rounded-full bg-black/15 shadow-inner transition-colors duration-300 peer-checked:bg-cn-yellow dark:bg-white/20"
                ></div>
                <div
                  class="absolute left-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-300 peer-checked:translate-x-5"
                ></div>
              </div>
            </label>
          </div>

          {#if eventRequiresPayment}
            <div
              class="grid grid-cols-2 gap-4 rounded-xl border border-cn-yellow/25 bg-cn-yellow/5 p-4"
              transition:slide={{ duration: 200 }}
            >
              <Input
                type="number"
                label="Montant (€)"
                bind:value={eventAmount as unknown as string}
                step="0.01"
              />
              <Input label="Devise" bind:value={eventCurrency} placeholder="eur" />
            </div>
          {/if}

          {#if availableForms.length > 0}
            <div class="pt-1">
              <label
                for="post-event-form-select"
                class="ml-1 mb-1.5 block text-[0.65rem] font-bold uppercase tracking-wider text-text-muted"
              >
                Formulaire lié (optionnel)
              </label>
              <div class="relative">
                <select id="post-event-form-select" bind:value={eventFormId} class={selectPlainClass}>
                  <option value="">— Aucun —</option>
                  {#each availableForms as form (form.id)}
                    <option value={form.id}>{form.title}</option>
                  {/each}
                </select>
                <div class={chevronWrapClass}>
                  <ChevronDown size={18} strokeWidth={2} />
                </div>
              </div>
            </div>
          {/if}
        </div>
      </div>
    {/if}

    {#if includeForm && !includeEventButton}
      <div transition:slide={{ duration: 300, easing: (t) => t * (2 - t) }} class={optionCardClass}>
        <div class="mb-4 flex items-center justify-between gap-2">
          <p
            class="flex items-center gap-2 text-[0.75rem] font-bold uppercase tracking-widest text-text-muted"
          >
            <ClipboardList size={16} strokeWidth={2.5} class={sectionIconClass} />
            Formulaire
          </p>
          <button
            type="button"
            onclick={() => (includeForm = false)}
            class="rounded-full p-1.5 text-text-muted transition-colors hover:bg-cn-surface hover:text-text-main"
            title="Retirer le formulaire"
          >
            <X size={16} />
          </button>
        </div>

        {#if availableForms.length === 0}
          <div class="rounded-xl bg-cn-surface/60 p-4 text-center dark:bg-white/5">
            <p class="text-sm font-medium text-text-muted">Aucun formulaire disponible.</p>
            <a
              href="/forms/create"
              class="mt-2 inline-block text-xs font-bold text-cn-yellow hover:underline"
            >
              Créer un formulaire
            </a>
          </div>
        {:else}
          <div class="relative">
            <select bind:value={selectedFormId} class={selectPlainClass}>
              <option value="">— Choisir un formulaire —</option>
              {#each availableForms as form (form.id)}
                <option value={form.id}>{form.title} ({form.items.length} questions)</option>
              {/each}
            </select>
            <div class={chevronWrapClass}>
              <ChevronDown size={18} strokeWidth={2} />
            </div>
          </div>
        {/if}
      </div>
    {/if}

    {#if errorMessage}
      <div
        transition:slide={{ duration: 200 }}
        class="flex items-start gap-3 rounded-xl border border-red-500/25 bg-red-500/10 p-3.5 text-red-600 shadow-inner dark:text-red-400"
      >
        <CircleAlert size={18} class="mt-0.5 shrink-0" />
        <span class="text-sm font-bold leading-snug">{errorMessage}</span>
      </div>
    {/if}

    <!-- Barre d’outils + publier -->
    <div
      class="flex flex-col-reverse gap-4 border-t border-cn-border/40 pt-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div
        class="custom-scrollbar flex flex-wrap items-stretch gap-2 overflow-x-auto rounded-2xl bg-cn-surface/50 p-1.5 ring-1 ring-cn-border/40 dark:bg-black/20"
      >
        <label
          for={imageInputId}
          title="Photos"
          class="flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-text-muted transition-all outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow active:scale-[0.98] sm:px-3 {selectedFiles.length >
          0
            ? 'bg-cn-yellow/20 font-semibold text-cn-dark dark:text-cn-yellow'
            : 'hover:bg-cn-border/40 hover:text-text-main'}"
        >
          <Image size={20} strokeWidth={selectedFiles.length > 0 ? 2.5 : 2} />
          <span class="hidden text-xs font-semibold sm:inline">Photos</span>
        </label>
        <input
          id={imageInputId}
          type="file"
          accept="image/*"
          multiple
          onchange={onPickFiles}
          class="sr-only"
        />

        <button
          type="button"
          title="Sondage"
          onclick={() => (includePoll = !includePoll)}
          class="flex items-center gap-2 rounded-xl px-2.5 py-2 text-text-muted transition-all outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow active:scale-[0.98] sm:px-3 {includePoll
            ? 'bg-cn-yellow/20 font-semibold text-cn-dark dark:text-cn-yellow'
            : 'hover:bg-cn-border/40 hover:text-text-main'}"
        >
          <ChartColumn size={20} strokeWidth={includePoll ? 2.5 : 2} />
          <span class="hidden text-xs font-semibold sm:inline">Sondage</span>
        </button>

        <button
          type="button"
          title="Événement"
          onclick={() => {
            includeEventButton = !includeEventButton;
            if (includeEventButton) includeForm = false;
          }}
          class="flex items-center gap-2 rounded-xl px-2.5 py-2 text-text-muted transition-all outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow active:scale-[0.98] sm:px-3 {includeEventButton
            ? 'bg-cn-yellow/20 font-semibold text-cn-dark dark:text-cn-yellow'
            : 'hover:bg-cn-border/40 hover:text-text-main'}"
        >
          <CalendarCheck size={20} strokeWidth={includeEventButton ? 2.5 : 2} />
          <span class="hidden text-xs font-semibold sm:inline">Événement</span>
        </button>

        {#if !includeEventButton}
          <button
            type="button"
            title="Formulaire"
            onclick={() => (includeForm = !includeForm)}
            class="flex items-center gap-2 rounded-xl px-2.5 py-2 text-text-muted transition-all outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow active:scale-[0.98] sm:px-3 {includeForm
              ? 'bg-cn-yellow/20 font-semibold text-cn-dark dark:text-cn-yellow'
              : 'hover:bg-cn-border/40 hover:text-text-main'}"
          >
            <ClipboardList size={20} strokeWidth={includeForm ? 2.5 : 2} />
            <span class="hidden text-xs font-semibold sm:inline">Formulaire</span>
          </button>
        {/if}
      </div>

      <Button
        type="button"
        class="min-w-[9rem] shrink-0 px-8 py-2.5 text-sm !font-extrabold sm:w-auto"
        disabled={publishing || (!markdown.trim() && selectedFiles.length === 0)}
        loading={publishing}
        onclick={publishPost}
      >
        {publishing ? 'Publication…' : 'Publier'}
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
</style>
