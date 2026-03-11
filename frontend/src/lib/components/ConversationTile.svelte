<script lang="ts">
  import Avatar from './Avatar.svelte';
  import { getPreviewText, parseEnvelope } from '$lib/envelope';

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
</script>

<button
  onclick={onClick}
  class="w-full p-3 flex items-center gap-4 rounded-2xl transition-colors text-left {isSelected
    ? 'bg-[color-mix(in_srgb,var(--cn-yellow)_26%,transparent)]'
    : unreadCount > 0
      ? 'bg-[color-mix(in_srgb,var(--cn-yellow)_10%,transparent)] hover:bg-[color-mix(in_srgb,var(--cn-yellow)_16%,transparent)]'
      : 'hover:bg-cn-bg'} animate-rise-in"
>
  <Avatar userId={contactName} size="lg" />

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
    <div class="text-sm truncate {unreadCount > 0 ? 'text-cn-dark font-semibold' : 'text-text-muted'}">
      {previewText || 'Canal E2E établi.'}
    </div>
  </div>
</button>
