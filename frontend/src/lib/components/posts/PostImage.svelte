<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { MediaService } from '$lib/media';
  import type { MediaRef } from '$lib/media';

  interface Props {
    media: {
      mediaId: string;
      key: string;
      iv: string;
      mimeType: string;
      size: number;
      fileName?: string;
    };
    authToken: string;
  }

  let { media, authToken }: Props = $props();

  let blobUrl = $state<string | null>(null);
  let loading = $state(true);
  let loadError = $state('');

  const mediaService = new MediaService();

  onMount(() => {
    if (!authToken) {
      loading = false;
      loadError = 'Missing auth token for media decryption';
      return;
    }

    void mediaService
      .downloadAndDecrypt(
        {
          type: 'image',
          mediaId: media.mediaId,
          key: media.key,
          iv: media.iv,
          mimeType: media.mimeType,
          size: media.size,
          fileName: media.fileName,
        } as MediaRef,
        authToken
      )
      .then((url) => {
        blobUrl = url;
      })
      .catch((err) => {
        loadError = err instanceof Error ? err.message : 'Unable to decrypt image';
      })
      .finally(() => {
        loading = false;
      });
  });

  onDestroy(() => {
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
    }
  });
</script>

{#if loading}
  <div class="h-36 w-full rounded-xl bg-white/60 animate-pulse"></div>
{:else if loadError}
  <div class="rounded-xl border border-red-200 bg-red-50 text-red-700 text-xs p-3">{loadError}</div>
{:else if blobUrl}
  <a href={blobUrl} target="_blank" rel="noopener noreferrer" class="block">
    <img
      src={blobUrl}
      alt={media.fileName ?? 'Post image'}
      class="w-full rounded-xl object-cover max-h-80"
    />
  </a>
{/if}
