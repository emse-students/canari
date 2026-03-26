<script lang="ts">
  import { generateAvatarPlaceholder, getInitials } from '$lib/utils/avatar';

  interface Props {
    userId: string;
    size?: 'sm' | 'md' | 'lg';
  }

  let { userId, size = 'md' }: Props = $props();
  const avatarSrc = $derived(generateAvatarPlaceholder(userId));
  let imageFailed = $state(false);
  const initials = $derived(getInitials(userId));

  const sizeClasses = $derived(
    size === 'sm' ? 'w-6 h-6 text-xs' : size === 'lg' ? 'w-12 h-12 text-base' : 'w-8 h-8 text-sm'
  );
</script>

{#if imageFailed}
  <div
    class="rounded-2xl shadow-sm ring-1 ring-white/20 flex-shrink-0 select-none {sizeClasses} bg-cn-dark text-cn-yellow flex items-center justify-center font-bold"
    title={userId}
    aria-label={`Avatar de ${userId}`}
  >
    {initials}
  </div>
{:else}
  <img
    src={avatarSrc}
    alt={`Avatar de ${userId}`}
    class="rounded-2xl object-cover shadow-sm ring-1 ring-white/20 flex-shrink-0 select-none {sizeClasses}"
    title={userId}
    onerror={() => {
      imageFailed = true;
    }}
  />
{/if}
