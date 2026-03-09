<script lang="ts">
  interface Props {
    contactName: string;
    displayName: string;
    lastMessage?: string;
    isReady: boolean;
    isSelected: boolean;
    onClick: () => void;
  }

  let { contactName, displayName, lastMessage, isReady, isSelected, onClick }: Props = $props();

  const avatarLetter = $derived(contactName[0]?.toUpperCase() || '?');
</script>

<button
  onclick={onClick}
  class="w-full p-3 flex items-center gap-4 rounded-2xl transition-colors text-left {isSelected
    ? 'bg-yellow-50'
    : 'hover:bg-cn-bg'}"
>
  <!-- Avatar -->
  <div
    class="w-12 h-12 bg-cn-yellow text-cn-dark rounded-[1.2rem] flex items-center justify-center font-extrabold text-xl flex-shrink-0"
  >
    {avatarLetter}
  </div>

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
