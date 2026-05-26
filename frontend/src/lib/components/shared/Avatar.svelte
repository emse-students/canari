<script lang="ts">
  import { generateAvatarPlaceholder, getInitials } from '$lib/utils/avatar';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';

  interface Props {
    /** ID of the user whose avatar should be displayed. */
    userId: string;
    /** Avatar size preset. */
    size?: 'xs' | 'sm' | 'md' | 'lg';
    /** When true, the avatar stretches to fill its container instead of using a preset size. */
    fill?: boolean;
    /** Border-radius style of the avatar. */
    shape?: 'soft' | 'circle';
    /** Text used for initials when the display name cannot be resolved. */
    fallbackLabel?: string;
  }

  let { userId, size = 'md', fill = false, shape = 'soft', fallbackLabel = '' }: Props = $props();

  function getCoreUrl(): string {
    const url =
      typeof import.meta !== 'undefined'
        ? ((import.meta as any).env?.VITE_CORE_URL as string | undefined)
        : undefined;
    if (url?.trim()) return url.trim();
    return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3012';
  }

  const avatarSrc = $derived(`${getCoreUrl()}/api/users/${encodeURIComponent(userId)}/avatar`);
  const _fallbackSrc = $derived(generateAvatarPlaceholder(userId));

  let imageFailed = $state(false);
  let imageLoaded = $state(false);
  let displayLabel = $state('');
  let resolveToken = 0;
  let lastResolvedUserId = $state('');
  const initials = $derived(getInitials(displayLabel));

  $effect(() => {
    const token = ++resolveToken;
    const fallback = fallbackLabel.trim();
    displayLabel = getUserDisplayNameSync(userId, fallback || undefined);
    resolveUserDisplayName(userId).then((resolved) => {
      if (token !== resolveToken) return;
      if (resolved) {
        displayLabel = resolved;
      } else if (fallback) {
        displayLabel = fallback;
      }
    });
  });

  $effect(() => {
    if (lastResolvedUserId !== userId) {
      lastResolvedUserId = userId;
      imageFailed = false;
      imageLoaded = false;
    }
  });

  const sizeClasses = $derived(
    fill
      ? 'w-full h-full text-base'
      : size === 'xs'
        ? 'w-4 h-4 text-[0.5rem]'
        : size === 'sm'
          ? 'w-6 h-6 text-xs'
          : size === 'lg'
            ? 'w-12 h-12 text-base'
            : 'w-8 h-8 text-sm'
  );
  const shapeClasses = $derived(shape === 'circle' ? 'rounded-full' : 'rounded-2xl');
</script>

{#if imageFailed}
  <div
    class="{shapeClasses} shadow-sm ring-1 ring-white/20 flex-shrink-0 select-none {sizeClasses} bg-cn-dark text-cn-yellow flex items-center justify-center font-bold overflow-hidden"
    title={displayLabel}
    aria-label={`Avatar de ${displayLabel}`}
  >
    {initials}
  </div>
{:else}
  <div
    class="{shapeClasses} shadow-sm ring-1 ring-white/20 flex-shrink-0 {sizeClasses} relative overflow-hidden"
    title={displayLabel}
    aria-label={`Avatar de ${displayLabel}`}
  >
    {#if !imageLoaded}
      <div class="absolute inset-0 bg-cn-border/40 animate-pulse"></div>
    {/if}
    <img
      src={avatarSrc}
      alt={`Avatar de ${displayLabel}`}
      class="w-full h-full object-cover select-none transition-opacity duration-150 {imageLoaded ? 'opacity-100' : 'opacity-0'}"
      onload={() => {
        imageLoaded = true;
      }}
      onerror={() => {
        imageFailed = true;
      }}
    />
  </div>
{/if}
