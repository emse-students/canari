<script lang="ts">
  import { generateAvatarPlaceholder, getInitials } from '$lib/utils/avatar';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';

  interface Props {
    userId: string;
    size?: 'sm' | 'md' | 'lg';
  }

  let { userId, size = 'md' }: Props = $props();

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
  let displayLabel = $state('');
  const initials = $derived(getInitials(displayLabel));

  $effect(() => {
    displayLabel = getUserDisplayNameSync(userId);
    resolveUserDisplayName(userId).then((resolved) => {
      if (resolved) displayLabel = resolved;
    });
  });

  const sizeClasses = $derived(
    size === 'sm' ? 'w-6 h-6 text-xs' : size === 'lg' ? 'w-12 h-12 text-base' : 'w-8 h-8 text-sm'
  );
</script>

{#if imageFailed}
  <div
    class="rounded-2xl shadow-sm ring-1 ring-white/20 flex-shrink-0 select-none {sizeClasses} bg-cn-dark text-cn-yellow flex items-center justify-center font-bold"
    title={displayLabel}
    aria-label={`Avatar de ${displayLabel}`}
  >
    {initials}
  </div>
{:else}
  <img
    src={avatarSrc}
    alt={`Avatar de ${displayLabel}`}
    class="rounded-2xl object-cover shadow-sm ring-1 ring-white/20 flex-shrink-0 select-none {sizeClasses}"
    title={displayLabel}
    onerror={() => {
      imageFailed = true;
    }}
  />
{/if}
