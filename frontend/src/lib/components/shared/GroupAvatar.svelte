<script lang="ts">
  import { Users } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import { MediaService } from '$lib/media';
  import { getToken } from '$lib/stores/auth';
  import { releaseRawMediaBlobUrl } from '$lib/utils/mediaBlobCache';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Media-service ID of the avatar image. When absent, falls back to icon/initials. */
    imageMediaId?: string | null;
    /** Display name used for initials fallback. */
    name?: string;
    /** Visual variant controls the fallback icon and color scheme. */
    variant?: 'group' | 'community';
    /** Avatar size preset. */
    size?: 'sm' | 'md' | 'lg';
    /** When true, the avatar stretches to fill its container instead of using a preset size. */
    fill?: boolean;
    /** Border-radius style of the avatar. */
    shape?: 'soft' | 'circle';
  }

  let {
    imageMediaId = null,
    name = '',
    variant = 'group',
    size = 'md',
    fill = false,
    shape = 'soft',
  }: Props = $props();

  let blobUrl = $state<string | null>(null);
  let loadFailed = $state(false);

  const mediaService = new MediaService();

  const sizeClasses = $derived(
    fill
      ? 'w-full h-full text-base'
      : size === 'sm'
        ? 'w-6 h-6 text-xs'
        : size === 'lg'
          ? 'w-12 h-12 text-base'
          : 'w-8 h-8 text-sm'
  );
  const shapeClasses = $derived(shape === 'circle' ? 'rounded-full' : 'rounded-2xl');

  const iconSize = $derived(size === 'sm' ? 14 : size === 'lg' ? 22 : 18);

  const fallbackClasses = $derived(
    variant === 'community' ? 'bg-amber-500 text-white' : 'bg-cn-dark text-cn-yellow'
  );

  function getInitials(n: string): string {
    return n
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('');
  }

  const initials = $derived(getInitials(name));

  let currentMediaId: string | null = null;
  let acquiredMediaId: string | null = null;

  async function loadImage(mediaId: string) {
    currentMediaId = mediaId;
    loadFailed = false;
    try {
      const token = await getToken();
      const url = await mediaService.downloadRaw(mediaId, token);
      if (currentMediaId !== mediaId) {
        releaseRawMediaBlobUrl(mediaId);
        return;
      }
      if (acquiredMediaId && acquiredMediaId !== mediaId) {
        releaseRawMediaBlobUrl(acquiredMediaId);
      }
      blobUrl = url;
      acquiredMediaId = mediaId;
    } catch {
      if (currentMediaId === mediaId) loadFailed = true;
    }
  }

  $effect(() => {
    if (imageMediaId) {
      loadImage(imageMediaId);
    } else {
      if (acquiredMediaId) {
        releaseRawMediaBlobUrl(acquiredMediaId);
        acquiredMediaId = null;
      }
      blobUrl = null;
      loadFailed = false;
    }
  });

  onDestroy(() => {
    if (acquiredMediaId) releaseRawMediaBlobUrl(acquiredMediaId);
  });
</script>

{#if blobUrl && !loadFailed}
  <img
    src={blobUrl}
    alt={name || m.group_avatar_fallback_alt()}
    class="{shapeClasses} object-cover shadow-sm ring-1 ring-white/20 flex-shrink-0 select-none {sizeClasses}"
  />
{:else}
  <div
    class="{shapeClasses} shadow-sm ring-1 ring-white/20 flex-shrink-0 select-none flex items-center justify-center font-bold {sizeClasses} {fallbackClasses}"
    title={name}
  >
    {#if initials}
      {initials}
    {:else}
      <Users size={iconSize} />
    {/if}
  </div>
{/if}
