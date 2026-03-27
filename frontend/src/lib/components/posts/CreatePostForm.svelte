<script lang="ts">
  import { Image, ChartColumn, CalendarCheck, ClipboardList, LoaderCircle, X } from 'lucide-svelte';
  import { MediaService } from '$lib/media';
  import { getToken } from '$lib/stores/auth';
  import { createPost, type CreatePostPayload } from '$lib/posts/api';
  import { getForms, type Form } from '$lib/forms/api';
  import { onMount } from 'svelte';
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

  let publishing = $state(false);
  let errorMessage = $state('');
  let authToken = $state('');

  const mediaService = new MediaService();

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
      if (!markdown.trim()) throw new Error('Le contenu du post est requis.');
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

      await createPost(payload);

      markdown = '';
      selectedFiles = [];
      filePreviews.forEach((url) => URL.revokeObjectURL(url));
      filePreviews = [];
      includePoll = false;
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

<div class="flex flex-col">
  <!-- Content textarea -->
  <textarea
    bind:value={markdown}
    placeholder="Partagez une annonce, un sondage ou un événement avec la communauté…"
    rows={5}
    class="w-full resize-none bg-transparent px-1 py-2 text-sm leading-relaxed text-text-main placeholder:text-text-muted focus:outline-none"
  ></textarea>

  <!-- Image previews -->
  {#if filePreviews.length > 0}
    <div class="flex flex-wrap gap-2 px-1 pb-3">
      {#each filePreviews as src, i (src)}
        <div
          class="relative h-20 w-20 overflow-hidden rounded-xl border border-cn-border shadow-sm"
        >
          <img {src} alt="Aperçu" class="h-full w-full object-cover" />
          <button
            type="button"
            onclick={() => removeFile(i)}
            class="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white transition-colors hover:bg-black/80"
            aria-label="Supprimer l'image"
          >
            <X size={10} />
          </button>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Poll section -->
  {#if includePoll}
    <div class="mx-1 mb-3 rounded-2xl border border-cn-border bg-cn-surface/40 p-4">
      <p class="mb-3 text-xs font-bold uppercase tracking-wide text-text-muted">Sondage</p>
      <div class="space-y-3">
        <Input
          label="Question"
          bind:value={pollQuestion}
          placeholder="Quelle est votre question ?"
        />
        <Textarea label="Options (une par ligne)" bind:value={pollOptionsRaw} rows={3} />
        <label class="flex cursor-pointer select-none items-center gap-2 text-sm text-text-main">
          <input
            type="checkbox"
            bind:checked={pollMultipleChoice}
            class="h-4 w-4 accent-cn-yellow"
          />
          Autoriser plusieurs réponses
        </label>
      </div>
    </div>
  {/if}

  <!-- Event button section -->
  {#if includeEventButton}
    <div class="mx-1 mb-3 rounded-2xl border border-cn-border bg-cn-surface/40 p-4">
      <p class="mb-3 text-xs font-bold uppercase tracking-wide text-text-muted">
        Bouton d'inscription
      </p>
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <Input label="Libellé du bouton" bind:value={eventLabel} placeholder="S'inscrire" />
          <Input label="ID de l'événement" bind:value={eventId} placeholder="evenement-2026" />
        </div>
        <Input
          type="number"
          label="Capacité (places)"
          bind:value={eventCapacity as unknown as string}
        />
        <label
          class="flex cursor-pointer select-none items-center gap-2 text-sm font-semibold text-text-main"
        >
          <input
            type="checkbox"
            bind:checked={eventRequiresPayment}
            class="h-4 w-4 accent-cn-yellow"
          />
          Inscription payante
        </label>
        {#if eventRequiresPayment}
          <div class="grid grid-cols-2 gap-3">
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
          <div>
            <!-- svelte-ignore a11y_label_has_associated_control -->
            <label class="mb-1.5 block text-sm font-semibold text-text-main">
              Formulaire d'inscription (optionnel)
            </label>
            <select
              bind:value={eventFormId}
              class="w-full appearance-none rounded-xl border border-cn-border bg-white px-3 py-2 text-sm transition-all focus:outline-none focus:ring-2 focus:ring-cn-yellow"
            >
              <option value="">— Aucun —</option>
              {#each availableForms as form (form._id)}
                <option value={form._id}>{form.title}</option>
              {/each}
            </select>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Standalone form section -->
  {#if includeForm && !includeEventButton}
    <div class="mx-1 mb-3 rounded-2xl border border-cn-border bg-cn-surface/40 p-4">
      <p class="mb-3 text-xs font-bold uppercase tracking-wide text-text-muted">Formulaire joint</p>
      {#if availableForms.length === 0}
        <p class="text-sm text-text-muted">
          Aucun formulaire disponible.
          <a href="/forms/create" class="font-semibold text-cn-dark underline">En créer un</a>
        </p>
      {:else}
        <select
          bind:value={selectedFormId}
          class="w-full appearance-none rounded-xl border border-cn-border bg-white px-3 py-2 text-sm transition-all focus:outline-none focus:ring-2 focus:ring-cn-yellow"
        >
          <option value="">— Choisir un formulaire —</option>
          {#each availableForms as form (form._id)}
            <option value={form._id}>{form.title} ({form.items.length} questions)</option>
          {/each}
        </select>
      {/if}
    </div>
  {/if}

  <!-- Error message -->
  {#if errorMessage}
    <div
      class="mx-1 mb-3 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600"
    >
      {errorMessage}
    </div>
  {/if}

  <!-- Toolbar -->
  <div class="flex items-center justify-between border-t border-cn-border pt-3">
    <div class="flex items-center gap-0.5">
      <!-- Image upload -->
      <label
        for={imageInputId}
        title="Ajouter des images"
        class="cursor-pointer rounded-lg p-2 transition-colors hover:bg-cn-bg hover:text-text-main {selectedFiles.length >
        0
          ? 'text-cn-dark'
          : 'text-text-muted'}"
      >
        <Image size={18} />
      </label>
      <input
        id={imageInputId}
        type="file"
        accept="image/*"
        multiple
        onchange={onPickFiles}
        class="sr-only"
      />

      <!-- Poll toggle -->
      <button
        type="button"
        title="Sondage"
        onclick={() => (includePoll = !includePoll)}
        class="rounded-lg p-2 transition-colors hover:bg-cn-bg hover:text-text-main {includePoll
          ? 'bg-cn-yellow/20 text-cn-dark'
          : 'text-text-muted'}"
      >
        <ChartColumn size={18} />
      </button>

      <!-- Event toggle -->
      <button
        type="button"
        title="Bouton d'événement"
        onclick={() => {
          includeEventButton = !includeEventButton;
          if (includeEventButton) includeForm = false;
        }}
        class="rounded-lg p-2 transition-colors hover:bg-cn-bg hover:text-text-main {includeEventButton
          ? 'bg-cn-yellow/20 text-cn-dark'
          : 'text-text-muted'}"
      >
        <CalendarCheck size={18} />
      </button>

      <!-- Form toggle (hidden when event is active) -->
      {#if !includeEventButton}
        <button
          type="button"
          title="Formulaire"
          onclick={() => (includeForm = !includeForm)}
          class="rounded-lg p-2 transition-colors hover:bg-cn-bg hover:text-text-main {includeForm
            ? 'bg-cn-yellow/20 text-cn-dark'
            : 'text-text-muted'}"
        >
          <ClipboardList size={18} />
        </button>
      {/if}
    </div>

    <!-- Publish button -->
    <button
      type="button"
      onclick={publishPost}
      disabled={publishing || !markdown.trim()}
      class="inline-flex items-center gap-2 rounded-xl bg-cn-yellow px-5 py-2 text-sm font-bold text-cn-dark shadow-sm transition-all hover:bg-cn-yellow-hover disabled:cursor-not-allowed disabled:opacity-50"
    >
      {#if publishing}
        <LoaderCircle size={14} class="animate-spin" />
        Publication…
      {:else}
        Publier
      {/if}
    </button>
  </div>
</div>
