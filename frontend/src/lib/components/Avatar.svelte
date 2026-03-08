<script lang="ts">
  import { generateAvatarColor, getInitials } from '$lib/utils/avatar';

  interface Props {
    userId: string;
    size?: 'sm' | 'md' | 'lg';
  }

  let { userId, size = 'md' }: Props = $props();

  const initials = $derived(getInitials(userId));
  const bgColor = $derived(generateAvatarColor(userId));

  const sizeClasses = $derived(
    size === 'sm' ? 'w-6 h-6 text-xs' : size === 'lg' ? 'w-12 h-12 text-base' : 'w-8 h-8 text-sm'
  );
</script>

<div
  class="rounded-full flex items-center justify-center text-white font-bold flex-shrink-0 select-none {sizeClasses}"
  style="background: {bgColor};"
  title={userId}
>
  {initials}
</div>
