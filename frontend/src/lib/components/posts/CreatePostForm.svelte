<script lang="ts">
  import {
    Image,
    ChartColumn,
    CalendarCheck,
    ClipboardList,
    Loader2,
    X,
    AlertCircle,
  } from 'lucide-svelte';
  import { MediaService } from '$lib/media';
  import { getToken } from '$lib/stores/auth';
  import { createPost, type CreatePostPayload } from '$lib/posts/api';
  import { getForms, type Form } from '$lib/forms/api';
  import { listMyAssociations, type Association } from '$lib/associations/api';
  import { onMount } from 'svelte';
  import { slide, fade } from 'svelte/transition';
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';

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
  let adminAssociations = $derived(
    myAssociations.filter((a) => a.role === 'admin' || a.role === 'owner')
  );
  let payableAssociations = $derived(adminAssociations.filter((a) => a.stripeOnboardingComplete));

  let publishing = $state(false);
  let errorMessage = $state('');
  let authToken = $state('');

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
      myAssociations = await listMyAssociations();
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

<div
  class="relative bg-white/70 dark:bg-[#151B2C]/70 backdrop-blur-2xl border border-black/5 dark:border-white/10 rounded-[1.5rem] p-4 sm:p-5 shadow-sm transition-all duration-300 focus-within:shadow-md mb-6"
>
  <!-- Sélecteurs d'Association (Header) -->
  {#if adminAssociations.length > 0}
    <div class="flex flex-wrap gap-4 pb-4 mb-3 border-b border-black/5 dark:border-white/10">
      <div class="flex-1 min-w-[160px]">
        <label
          for="post-association-select"
          class="block text-[0.65rem] font-bold uppercase tracking-wider text-text-muted mb-1.5 ml-1"
          >Publier en tant que</label
        >
        <div class="relative">
          <select
            id="post-association-select"
            bind:value={selectedAssociationId}
            class="w-full appearance-none rounded-xl border border-transparent bg-black/5 dark:bg-white/5 hover:border-black/10 dark:hover:border-white/10 px-4 py-2.5 text-sm font-bold text-text-main transition-all outline-none focus:ring-2 focus:ring-amber-500/50"
          >
            <option value="">👤 Mon profil personnel</option>
            {#each adminAssociations as a (a.id)}
              <option value={a.id}>🏢 {a.name}</option>
            {/each}
          </select>
          <!-- Custom Chevron pour masquer l'icône navigateur par défaut -->
          <div
            class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-text-muted"
          >
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"
              ><path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M19 9l-7 7-7-7"
              ></path></svg
            >
          </div>
        </div>
      </div>

      {#if payableAssociations.length > 0 && selectedAssociationId}
        <div class="flex-1 min-w-[160px]" transition:fade={{ duration: 200 }}>
          <label
            for="post-payment-association-select"
            class="block text-[0.65rem] font-bold uppercase tracking-wider text-text-muted mb-1.5 ml-1"
            >Comptabilité (Stripe)</label
          >
          <div class="relative">
            <select
              id="post-payment-association-select"
              bind:value={selectedPaymentAssociationId}
              class="w-full appearance-none rounded-xl border border-transparent bg-black/5 dark:bg-white/5 hover:border-black/10 dark:hover:border-white/10 px-4 py-2.5 text-sm font-bold text-text-main transition-all outline-none focus:ring-2 focus:ring-amber-500/50"
            >
              <option value="">— Aucune —</option>
              {#each payableAssociations as a (a.id)}
                <option value={a.id}>{a.name}</option>
              {/each}
            </select>
            <div
              class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-text-muted"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                ><path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M19 9l-7 7-7-7"
                ></path></svg
              >
            </div>
          </div>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Zone de Saisie Principale -->
  <textarea
    bind:value={markdown}
    placeholder="Partagez une annonce, un sondage ou un événement avec la communauté…"
    rows={4}
    class="w-full resize-none bg-transparent px-2 py-3 text-[1rem] leading-relaxed font-medium text-text-main placeholder:text-text-muted/60 outline-none custom-scrollbar min-h-[100px]"
  ></textarea>

  <!-- Aperçus d'images -->
  {#if filePreviews.length > 0}
    <div
      class="grid grid-cols-3 sm:grid-cols-4 gap-2 pt-2 pb-4 px-1"
      transition:slide={{ duration: 200 }}
    >
      {#each filePreviews as src, i (src)}
        <div
          class="relative aspect-square overflow-hidden rounded-2xl border border-black/5 dark:border-white/10 shadow-sm group"
        >
          <img
            {src}
            alt="Aperçu de la publication"
            class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
          <button
            type="button"
            onclick={() => removeFile(i)}
            class="absolute right-1.5 top-1.5 rounded-full bg-black/60 backdrop-blur-md p-1.5 text-white transition-all hover:bg-red-500 hover:scale-110 active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            aria-label="Supprimer l'image"
            title="Supprimer"
          >
            <X size={14} strokeWidth={2.5} />
          </button>
        </div>
      {/each}
    </div>
  {/if}

  <!-- ================= OPTIONS SUPPLÉMENTAIRES (Animées) ================= -->
  <div class="flex flex-col gap-4 mt-2">
    <!-- Section Sondage -->
    {#if includePoll}
      <div
        transition:slide={{ duration: 300, easing: (t) => t * (2 - t) }}
        class="rounded-2xl border border-black/5 dark:border-white/10 bg-white/50 dark:bg-black/20 p-5 shadow-sm"
      >
        <div class="flex items-center justify-between mb-4">
          <p
            class="text-[0.75rem] font-bold uppercase tracking-widest text-text-muted flex items-center gap-2"
          >
            <ChartColumn size={16} strokeWidth={2.5} class="text-amber-500" />
            Créer un sondage
          </p>
          <button
            onclick={() => (includePoll = false)}
            class="p-1 rounded-full text-text-muted hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
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

          <!-- Switch Animé -->
          <label
            class="flex items-center justify-between cursor-pointer select-none group/toggle bg-black/5 dark:bg-white/5 rounded-xl px-4 py-3 hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
          >
            <span class="text-sm font-semibold text-text-main"> Autoriser plusieurs réponses </span>
            <div class="relative flex items-center">
              <input type="checkbox" bind:checked={pollMultipleChoice} class="peer sr-only" />
              <div
                class="w-11 h-6 bg-black/20 dark:bg-white/20 rounded-full peer-checked:bg-amber-500 shadow-inner transition-colors duration-300"
              ></div>
              <div
                class="absolute left-1 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-300 peer-checked:translate-x-5"
              ></div>
            </div>
          </label>
        </div>
      </div>
    {/if}

    <!-- Section Événement -->
    {#if includeEventButton}
      <div
        transition:slide={{ duration: 300, easing: (t) => t * (2 - t) }}
        class="rounded-2xl border border-black/5 dark:border-white/10 bg-white/50 dark:bg-black/20 p-5 shadow-sm"
      >
        <div class="flex items-center justify-between mb-4">
          <p
            class="text-[0.75rem] font-bold uppercase tracking-widest text-text-muted flex items-center gap-2"
          >
            <CalendarCheck size={16} strokeWidth={2.5} class="text-amber-500" />
            Bouton d'Événement
          </p>
          <button
            onclick={() => (includeEventButton = false)}
            class="p-1 rounded-full text-text-muted hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            title="Retirer l'événement"
          >
            <X size={16} />
          </button>
        </div>

        <div class="space-y-4">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Libellé du bouton"
              bind:value={eventLabel}
              placeholder="Ex: S'inscrire à l'AgA"
            />
            <Input
              label="ID unique de l'événement"
              bind:value={eventId}
              placeholder="ex: wei-2026"
            />
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
            <Input
              type="number"
              label="Capacité max (places)"
              bind:value={eventCapacity as unknown as string}
            />

            <!-- Switch Inscription Payante -->
            <label
              class="flex items-center justify-between cursor-pointer select-none group/toggle bg-black/5 dark:bg-white/5 rounded-xl px-4 py-3 hover:bg-black/10 dark:hover:bg-white/10 transition-colors h-[46px] sm:mb-[2px]"
            >
              <span class="text-sm font-semibold text-text-main"> Inscription payante </span>
              <div class="relative flex items-center">
                <input type="checkbox" bind:checked={eventRequiresPayment} class="peer sr-only" />
                <div
                  class="w-11 h-6 bg-black/20 dark:bg-white/20 rounded-full peer-checked:bg-amber-500 shadow-inner transition-colors duration-300"
                ></div>
                <div
                  class="absolute left-1 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-300 peer-checked:translate-x-5"
                ></div>
              </div>
            </label>
          </div>

          {#if eventRequiresPayment}
            <div
              class="grid grid-cols-2 gap-4 bg-amber-500/5 p-4 rounded-xl border border-amber-500/20"
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
            <div class="pt-2">
              <label
                for="post-event-form-select"
                class="block text-[0.65rem] font-bold uppercase tracking-wider text-text-muted mb-1.5 ml-1"
              >
                Lier à un Formulaire (Optionnel)
              </label>
              <div class="relative">
                <select
                  id="post-event-form-select"
                  bind:value={eventFormId}
                  class="w-full appearance-none rounded-xl border border-black/10 dark:border-white/10 bg-white/60 dark:bg-black/30 px-4 py-3 text-sm font-medium text-text-main transition-all outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20"
                >
                  <option value="">— Aucun —</option>
                  {#each availableForms as form (form.id)}
                    <option value={form.id}>{form.title}</option>
                  {/each}
                </select>
                <div
                  class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-text-muted"
                >
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    ><path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M19 9l-7 7-7-7"
                    ></path></svg
                  >
                </div>
              </div>
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Section Formulaire Seul -->
    {#if includeForm && !includeEventButton}
      <div
        transition:slide={{ duration: 300, easing: (t) => t * (2 - t) }}
        class="rounded-2xl border border-black/5 dark:border-white/10 bg-white/50 dark:bg-black/20 p-5 shadow-sm"
      >
        <div class="flex items-center justify-between mb-4">
          <p
            class="text-[0.75rem] font-bold uppercase tracking-widest text-text-muted flex items-center gap-2"
          >
            <ClipboardList size={16} strokeWidth={2.5} class="text-amber-500" />
            Joindre un Formulaire
          </p>
          <button
            onclick={() => (includeForm = false)}
            class="p-1 rounded-full text-text-muted hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            title="Retirer le formulaire"
          >
            <X size={16} />
          </button>
        </div>

        {#if availableForms.length === 0}
          <div class="bg-black/5 dark:bg-white/5 rounded-xl p-4 text-center">
            <p class="text-sm font-medium text-text-muted">Aucun formulaire disponible.</p>
            <a
              href="/forms/create"
              class="inline-block mt-2 text-xs font-bold text-amber-600 dark:text-amber-400 hover:underline"
            >
              Créer un nouveau formulaire
            </a>
          </div>
        {:else}
          <div class="relative">
            <select
              bind:value={selectedFormId}
              class="w-full appearance-none rounded-xl border border-black/10 dark:border-white/10 bg-white/60 dark:bg-black/30 px-4 py-3 text-sm font-medium text-text-main transition-all outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20"
            >
              <option value="">— Choisir un formulaire —</option>
              {#each availableForms as form (form.id)}
                <option value={form.id}>{form.title} ({form.items.length} questions)</option>
              {/each}
            </select>
            <div
              class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-text-muted"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                ><path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M19 9l-7 7-7-7"
                ></path></svg
              >
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Message d'Erreur -->
    {#if errorMessage}
      <div
        transition:slide={{ duration: 200 }}
        class="flex items-start gap-3 p-3.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 shadow-inner"
      >
        <AlertCircle size={18} class="shrink-0 mt-0.5" />
        <span class="text-sm font-bold leading-snug">{errorMessage}</span>
      </div>
    {/if}
  </div>

  <!-- ================= BARRE D'OUTILS ET BOUTON PUBLIER ================= -->
  <div
    class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-t border-black/5 dark:border-white/10 pt-4 mt-2"
  >
    <div class="flex items-center gap-1.5 overflow-x-auto custom-scrollbar pb-1 sm:pb-0">
      <!-- Upload d'images -->
      <label
        for={imageInputId}
        title="Ajouter des images"
        class="cursor-pointer rounded-xl p-2.5 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 {selectedFiles.length >
        0
          ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
          : 'text-text-muted hover:bg-black/5 dark:hover:bg-white/10 hover:text-amber-500'}"
      >
        <Image size={20} strokeWidth={selectedFiles.length > 0 ? 2.5 : 2} />
      </label>
      <input
        id={imageInputId}
        type="file"
        accept="image/*"
        multiple
        onchange={onPickFiles}
        class="sr-only"
      />

      <!-- Toggle Sondage -->
      <button
        type="button"
        title="Ajouter un sondage"
        onclick={() => (includePoll = !includePoll)}
        class="rounded-xl p-2.5 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 {includePoll
          ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
          : 'text-text-muted hover:bg-black/5 dark:hover:bg-white/10 hover:text-amber-500'}"
      >
        <ChartColumn size={20} strokeWidth={includePoll ? 2.5 : 2} />
      </button>

      <!-- Toggle Événement -->
      <button
        type="button"
        title="Ajouter un événement"
        onclick={() => {
          includeEventButton = !includeEventButton;
          if (includeEventButton) includeForm = false;
        }}
        class="rounded-xl p-2.5 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 {includeEventButton
          ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
          : 'text-text-muted hover:bg-black/5 dark:hover:bg-white/10 hover:text-amber-500'}"
      >
        <CalendarCheck size={20} strokeWidth={includeEventButton ? 2.5 : 2} />
      </button>

      <!-- Toggle Formulaire (désactivé si événement) -->
      {#if !includeEventButton}
        <button
          type="button"
          title="Ajouter un formulaire"
          onclick={() => (includeForm = !includeForm)}
          class="rounded-xl p-2.5 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 {includeForm
            ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
            : 'text-text-muted hover:bg-black/5 dark:hover:bg-white/10 hover:text-amber-500'}"
        >
          <ClipboardList size={20} strokeWidth={includeForm ? 2.5 : 2} />
        </button>
      {/if}
    </div>

    <!-- Bouton Publier -->
    <button
      type="button"
      onclick={publishPost}
      disabled={publishing || (!markdown.trim() && selectedFiles.length === 0)}
      class="inline-flex items-center justify-center gap-2 rounded-xl bg-amber-500 px-6 py-2.5 text-sm font-extrabold text-[#151B2C] shadow-md shadow-amber-500/20 transition-all hover:bg-amber-400 hover:-translate-y-0.5 active:translate-y-0 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:hover:translate-y-0 w-full sm:w-auto outline-none focus-visible:ring-4 focus-visible:ring-amber-500/50"
    >
      {#if publishing}
        <Loader2 size={18} class="animate-spin" strokeWidth={3} />
        Publication…
      {:else}
        Publier
      {/if}
    </button>
  </div>
</div>

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
