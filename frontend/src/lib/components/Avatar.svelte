<script lang="ts">
  import { generateAvatarPlaceholder } from '$lib/utils/avatar';

  interface Props {
    userId: string;
    size?: 'sm' | 'md' | 'lg';
  }

  let { userId, size = 'md' }: Props = $props();
  const avatarSrc = $derived(generateAvatarPlaceholder(userId));

  const sizeClasses = $derived(
    size === 'sm' ? 'w-6 h-6 text-xs' : size === 'lg' ? 'w-12 h-12 text-base' : 'w-8 h-8 text-sm'
  );
</script>

<img
  src={avatarSrc}
  alt={`Avatar de ${userId}`}
  class="rounded-2xl object-cover shadow-sm ring-1 ring-white/20 flex-shrink-0 select-none {sizeClasses}"
  title={userId}
/>
