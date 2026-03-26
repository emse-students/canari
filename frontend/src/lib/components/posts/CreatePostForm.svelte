<script lang="ts">
  import { MediaService } from '$lib/media';
  import { getToken } from '$lib/stores/auth';
  import { createPost, type CreatePostPayload } from '$lib/posts/api';
  import { getForms, type Form } from '$lib/forms/api';
  import { onMount } from 'svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';

  interface Props {
    onPostCreated: () => void;
    email?: string;
    authToken?: string;
  }

  let { onPostCreated, email = $bindable(''), authToken = $bindable('') }: Props = $props();

  let markdown = $state('');
  let selectedFiles = $state<File[]>([]);

  let includePoll = $state(false);
  let pollQuestion = $state('');
  let pollOptionsRaw = $state('Yes\nNo');
  let pollMultipleChoice = $state(false);

  let includeEventButton = $state(false);

  const imageInputId = 'create-post-images-input';
  let eventLabel = $state('Register now');
  let eventId = $state('event-2026');
  let eventRequiresPayment = $state(false);
  let eventAmount = $state<number>(25);
  let eventCurrency = $state('eur');
  let eventCapacity = $state<number>(100);
  let eventFormId = $state('');

  // Form referencing (standalone — only used when no event button)
  let availableForms = $state<Form[]>([]);
  let selectedFormId = $state('');
  let includeForm = $state(false);

  let publishing = $state(false);
  let errorMessage = $state('');
  let actionMessage = $state('');

  const mediaService = new MediaService();

  onMount(async () => {
    // Silently acquire auth token for media uploads
    try {
      authToken = await getToken();
    } catch {
      // will be retried when the user tries to upload
    }
    try {
      availableForms = await getForms();
    } catch (e) {
      console.error('Failed to load forms', e);
    }
  });

  async function createSessionToken() {
    actionMessage = '';
    errorMessage = '';
    try {
      authToken = await getToken();
      actionMessage = 'Token generated for media-service operations.';
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Unable to generate token';
    }
  }

  function onPickFiles(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []).filter((file) => file.type.startsWith('image/'));
    selectedFiles = files;
  }

  async function publishPost() {
    publishing = true;
    errorMessage = '';
    actionMessage = '';

    try {
      if (!markdown.trim()) {
        throw new Error('Post markdown is required.');
      }
      if (selectedFiles.length > 0 && !authToken) {
        throw new Error('Generate a token before uploading images.');
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

      const payload: CreatePostPayload = {
        markdown,
        images,
      };

      if (includePoll) {
        const options = pollOptionsRaw
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean)
          .map((label) => ({ label }));
        if (pollQuestion.trim() && options.length >= 2) {
          payload.polls = [
            {
              question: pollQuestion.trim(),
              options,
              multipleChoice: pollMultipleChoice,
            },
          ];
        }
      }

      if (includeEventButton) {
        if (!eventLabel.trim() || !eventId.trim()) {
          throw new Error('Event label and eventId are required when event button is enabled.');
        }
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
        if (!selectedFormId) {
          throw new Error('Please select a form to attach.');
        }
        payload.attachedFormId = selectedFormId;
      }

      await createPost(payload);
      markdown = '';
      selectedFiles = [];
      includeForm = false;
      includePoll = false;
      includeEventButton = false;
      actionMessage = 'Post published.';
      onPostCreated();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Unable to publish post';
    } finally {
      publishing = false;
    }
  }
</script>

<Card title="Create a Post" class="h-fit">
  <div class="space-y-4">
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Input label="Email (for receipts)" bind:value={email} placeholder="alice@example.com" />
    </div>

    <Textarea
      label="Content (Markdown)"
      bind:value={markdown}
      placeholder="# Hello World"
      rows={6}
    />

    <div>
      <label for={imageInputId} class="block text-sm font-bold text-text-main mb-2 ml-1"
        >Images</label
      >
      <input
        id={imageInputId}
        type="file"
        accept="image/*"
        multiple
        onchange={onPickFiles}
        class="block w-full text-sm text-text-muted
            file:mr-4 file:py-2 file:px-4
            file:rounded-full file:border-0
            file:text-sm file:font-semibold
            file:bg-cn-yellow file:text-cn-dark
            hover:file:bg-cn-yellow-hover"
      />
    </div>

    <!-- Poll Section -->
    <div class="rounded-2xl border border-cn-border p-4 bg-cn-surface/50">
      <label class="flex items-center gap-2 font-bold text-sm cursor-pointer mb-2">
        <input type="checkbox" bind:checked={includePoll} class="accent-cn-yellow w-4 h-4" />
        Include Poll
      </label>

      {#if includePoll}
        <div class="space-y-3 mt-3 pl-2 border-l-2 border-cn-border">
          <Input label="Question" bind:value={pollQuestion} placeholder="What do you think?" />
          <Textarea label="Options (one per line)" bind:value={pollOptionsRaw} rows={3} />
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" bind:checked={pollMultipleChoice} class="accent-cn-yellow" />
            Allow multiple choices
          </label>
        </div>
      {/if}
    </div>

    <!-- Event Button Section -->
    <div class="rounded-2xl border border-cn-border p-4 bg-cn-surface/50">
      <label class="flex items-center gap-2 font-bold text-sm cursor-pointer mb-2">
        <input type="checkbox" bind:checked={includeEventButton} class="accent-cn-yellow w-4 h-4" />
        Include Event Button
      </label>

      {#if includeEventButton}
        <div class="space-y-3 mt-3 pl-2 border-l-2 border-cn-border">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Button Label" bind:value={eventLabel} />
            <Input label="Event ID" bind:value={eventId} />
          </div>

          <label class="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" bind:checked={eventRequiresPayment} class="accent-cn-yellow" />
            Requires Payment
          </label>

          {#if eventRequiresPayment}
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                type="number"
                label="Amount"
                bind:value={eventAmount as unknown as string}
                step="0.01"
              />
              <Input label="Currency" bind:value={eventCurrency} />
            </div>
          {/if}
          <Input type="number" label="Capacity" bind:value={eventCapacity as unknown as string} />

          <!-- Attach a registration form to this event -->
          {#if availableForms.length > 0}
            <div>
              <!-- svelte-ignore a11y_label_has_associated_control -->
              <label class="block text-sm font-semibold text-text-main mb-1">
                Formulaire d'inscription (optionnel)
              </label>
              <select
                bind:value={eventFormId}
                class="w-full appearance-none rounded-xl border border-cn-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cn-yellow transition-all"
              >
                <option value="">-- Aucun formulaire --</option>
                {#each availableForms as form (form._id)}
                  <option value={form._id}>{form.title}</option>
                {/each}
              </select>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Standalone Form Section (only when no event button) -->
    <div
      class="rounded-2xl border border-cn-border p-4 bg-cn-surface/50"
      class:hidden={includeEventButton}
    >
      <label class="flex items-center gap-2 font-bold text-sm cursor-pointer mb-2">
        <input type="checkbox" bind:checked={includeForm} class="accent-cn-yellow w-4 h-4" />
        Joindre un formulaire d'inscription
      </label>

      {#if includeForm}
        <div class="space-y-4 mt-3 pl-2 border-l-2 border-cn-border">
          <span class="block text-sm font-bold text-text-main mb-1">Sélectionner un formulaire</span
          >
          {#if availableForms.length === 0}
            <div class="text-sm text-gray-500">
              Aucun formulaire disponible. <a href="/forms/create" class="text-blue-500 underline"
                >En créer un d'abord</a
              >
            </div>
          {:else}
            <div class="relative">
              <select
                bind:value={selectedFormId}
                class="w-full appearance-none rounded-xl border border-cn-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cn-yellow transition-all pr-8"
              >
                <option value="">-- Choisir un formulaire --</option>
                {#each availableForms as form (form._id)}
                  <option value={form._id}>{form.title} ({form.items.length} questions)</option>
                {/each}
              </select>
              <div
                class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-text-muted"
              >
                <svg
                  class="fill-current h-4 w-4"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  ><path
                    d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"
                  /></svg
                >
              </div>
            </div>
          {/if}
          <div class="text-xs text-gray-500 mt-2 flex items-center gap-2">
            <span>Les formulaires doivent être créés dans le</span>
            <a
              href="/forms"
              class="inline-flex items-center gap-1 font-semibold text-blue-600 hover:text-blue-800 bg-blue-50 px-2 py-0.5 rounded border border-blue-200"
            >
              <span>Gestionnaire de formulaires</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                class="w-3 h-3"
              >
                <path
                  fill-rule="evenodd"
                  d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5z"
                  clip-rule="evenodd"
                />
                <path
                  fill-rule="evenodd"
                  d="M6.194 12.753a.75.75 0 001.06.053L16.5 4.44v2.81a.75.75 0 001.5 0v-4.5a.75.75 0 00-.75-.75h-4.5a.75.75 0 000 1.5h2.553l-9.056 8.194a.75.75 0 00-.053 1.06z"
                  clip-rule="evenodd"
                />
              </svg>
            </a>
          </div>
        </div>
      {/if}
    </div>

    {#if errorMessage}
      <div class="p-3 rounded-xl bg-red-50 text-red-600 text-sm font-medium border border-red-100">
        {errorMessage}
      </div>
    {/if}
    {#if actionMessage}
      <div
        class="p-3 rounded-xl bg-green-50 text-green-600 text-sm font-medium border border-green-100"
      >
        {actionMessage}
      </div>
    {/if}

    <Button class="w-full" loading={publishing} onclick={publishPost}>Publish Post</Button>
  </div>
</Card>
