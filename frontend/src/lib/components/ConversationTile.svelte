<script lang="ts">
  import Avatar from './Avatar.svelte';

  interface Props {
    contactName: string;
    displayName: string;
    lastMessage?: string;
    isReady: boolean;
    isSelected: boolean;
    onClick: () => void;
  }

  let { contactName, displayName, lastMessage, isReady, isSelected, onClick }: Props = $props();

</script>

<button
  onclick={onClick}
  class="w-full p-3 flex items-center gap-4 rounded-2xl transition-colors text-left {isSelected
    ? 'bg-[color-mix(in_srgb,var(--cn-yellow)_26%,transparent)]'
    : 'hover:bg-cn-bg'} animate-rise-in"
>
  <Avatar userId={contactName} size="lg" />

  <!-- Info -->
  <div class="flex-1 min-w-0">
    <div class="flex justify-between items-center mb-1">
      <span class="font-bold text-cn-dark truncate">{displayName}</span>
      {#if !isReady}
        <span
          class="bg-yellow-200 text-yellow-900 text-[0.6rem] px-2 py-0.5 rounded-full font-extrabold uppercase"
          >sync</span
        >
      {/if}
    </div>
    <div class="text-sm text-text-muted truncate">
      {lastMessage || 'Canal E2E établi.'}
    </div>
  </div>
</button>
