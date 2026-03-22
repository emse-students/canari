<script lang="ts">
  import Avatar from './Avatar.svelte';
  import { getPreviewText, parseEnvelope } from '$lib/envelope';
  import { presenceMap, watchUsers } from '$lib/stores/presenceStore';
  import { onMount } from 'svelte';

  interface Props {
    contactName: string;
    displayName: string;
    lastMessage?: string;
    isReady: boolean;
    isSelected: boolean;
    unreadCount?: number;
    onClick: () => void;
  }

  let {
    contactName,
    displayName,
    lastMessage,
    isReady,
    isSelected,
    unreadCount = 0,
    onClick,
  }: Props = $props();
  let previewText = $derived(lastMessage ? getPreviewText(parseEnvelope(lastMessage)) : null);
  let isOnline = $derived($presenceMap[contactName] || false);
  onMount(() => {
    watchUsers([contactName]);
  });
</script>

<button
  onclick={onClick}
  class="w-full p-3 flex items-center gap-4 rounded-2xl transition-colors text-left {isSelected
    ? 'bg-white/55 dark:bg-black/35 border border-white/60 dark:border-white/10'
    : unreadCount > 0
      ? 'bg-white/25 dark:bg-black/20 hover:bg-white/30 dark:hover:bg-black/30 border border-white/45 dark:border-white/10'
      : 'hover:bg-white/30 dark:hover:bg-black/30 border border-transparent'} animate-rise-in"
>
  <div class="relative flex-shrink-0">
    <Avatar userId={contactName} size="lg" />
    {#if isOnline}
      <span
        class="absolute bottom-0 right-0 block h-3.5 w-3.5 rounded-full ring-2 ring-white bg-green-500"
      ></span>
    {/if}
  </div>

  <!-- Info -->
  <div class="flex-1 min-w-0">
    <div class="flex justify-between items-center mb-1 gap-2">
      <span class="text-cn-dark truncate {unreadCount > 0 ? 'font-extrabold' : 'font-bold'}"
        >{displayName}</span
      >
      <div class="flex items-center gap-1.5 flex-shrink-0">
        {#if unreadCount > 0}
          <span
            class="min-w-5 h-5 px-1 rounded-full bg-cn-dark text-cn-yellow text-[0.65rem] font-extrabold inline-flex items-center justify-center"
            aria-label={`${unreadCount} message(s) non lus`}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        {/if}
        {#if !isReady}
          <span
            class="bg-yellow-200 text-yellow-900 text-[0.6rem] px-2 py-0.5 rounded-full font-extrabold uppercase"
            >sync</span
          >
        {/if}
      </div>
    </div>
    <div
      class="text-sm truncate {unreadCount > 0 ? 'text-cn-dark font-semibold' : 'text-text-muted'}"
    >
      {previewText || 'Canal E2E établi.'}
    </div>
  </div>
</button>
