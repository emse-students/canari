<script lang="ts">
  import { MediaService } from '$lib/media';
  import { generateDevToken } from '$lib/utils/mainChatAuth';
  import { createPost, type CreatePostPayload } from '$lib/posts/api';
  import Button from '$lib/components/ui/Button.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';

  interface Props {
    onPostCreated: () => void;
    userId?: string;
    email?: string;
    authToken?: string;
  }

  let {
    onPostCreated,
    userId = $bindable(''),
    email = $bindable(''),
    authToken = $bindable(''),
  }: Props = $props();

  let markdown = $state('');
  let selectedFiles = $state<File[]>([]);

  let includePoll = $state(false);
  let pollQuestion = $state('');
  let pollOptionsRaw = $state('Yes\nNo');
  let pollMultipleChoice = $state(false);

  let includeEventButton = $state(false);
  let eventLabel = $state('Register now');
  let eventId = $state('event-2026');
  let eventRequiresPayment = $state(false);
  let eventAmountCents = $state<number>(2500);
  let eventCurrency = $state('eur');
  let eventCapacity = $state<number>(100);

  let publishing = $state(false);
  let errorMessage = $state('');
  let actionMessage = $state('');

  const mediaService = new MediaService();
  const jwtSecret = import.meta.env.VITE_JWT_SECRET as string | undefined;

  async function createSessionToken() {
    actionMessage = '';
    errorMessage = '';
    try {
      authToken = await generateDevToken(userId, jwtSecret, import.meta.env.DEV);
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
      if (!userId.trim()) {
        throw new Error('Please provide user id before publishing.');
      }
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
        authorId: userId.trim(),
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
            amountCents: eventRequiresPayment ? Number(eventAmountCents) : undefined,
            currency: eventRequiresPayment ? eventCurrency.toLowerCase() : undefined,
            capacity: Number(eventCapacity),
          },
        ];
      }

      await createPost(payload);
      markdown = '';
      selectedFiles = [];
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
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Input label="User ID" bind:value={userId} placeholder="alice" />
      <Input label="Email (for receipts)" bind:value={email} placeholder="alice@example.com" />
    </div>

    {#if !authToken}
      <Button class="w-full" variant="outline" onclick={createSessionToken}>
        Generate Upload Token
      </Button>
    {:else}
      <div class="text-xs text-green-600 font-mono">Token active</div>
    {/if}

    <Textarea
      label="Content (Markdown)"
      bind:value={markdown}
      placeholder="# Hello World"
      rows={6}
    />

    <div>
      <label class="block text-sm font-bold text-text-main mb-2 ml-1">Images</label>
      <input
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
          <div class="grid grid-cols-2 gap-3">
            <Input label="Button Label" bind:value={eventLabel} />
            <Input label="Event ID" bind:value={eventId} />
          </div>

          <label class="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" bind:checked={eventRequiresPayment} class="accent-cn-yellow" />
            Requires Payment
          </label>

          {#if eventRequiresPayment}
            <div class="grid grid-cols-2 gap-3">
              <Input
                type="number"
                label="Amount (Cents)"
                bind:value={eventAmountCents as unknown as string}
              />
              <Input label="Currency" bind:value={eventCurrency} />
            </div>
          {/if}
          <Input type="number" label="Capacity" bind:value={eventCapacity as unknown as string} />
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
