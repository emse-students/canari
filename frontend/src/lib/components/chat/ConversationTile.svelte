<script lang="ts">
  import Avatar from '../shared/Avatar.svelte';
  import { Users } from 'lucide-svelte';
  import { getPreviewText, parseEnvelope } from '$lib/envelope';
  import { presenceMap, watchUsers } from '$lib/stores/presenceStore';
  import { onMount } from 'svelte';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';

  interface Props {
    contactName: string;
    displayName: string;
    conversationType?: 'direct' | 'group' | 'channel';
    lastMessage?: string;
    isReady: boolean;
    isSelected: boolean;
    unreadCount?: number;
    onClick: () => void;
  }

  let {
    contactName,
    displayName,
    conversationType = 'group',
    lastMessage,
    isReady,
    isSelected,
    unreadCount = 0,
    onClick,
  }: Props = $props();

  // Only direct conversations have a real peer user ID — group/channel names are
  // display names, not user IDs, so we must not use them for presence or avatars.
  const isDirect = $derived(conversationType === 'direct');

  let previewText = $derived(lastMessage ? getPreviewText(parseEnvelope(lastMessage)) : null);
  let isOnline = $derived(isDirect ? $presenceMap[contactName] || false : false);
  let resolvedDisplayName = $state('');

  const effectiveDisplayName = $derived(
    displayName && displayName !== contactName ? displayName : resolvedDisplayName
  );

  onMount(() => {
    // Only poll presence for real user IDs (direct conversations).
    if (isDirect) watchUsers([contactName]);
  });

  $effect(() => {
    if (isDirect) {
      resolvedDisplayName = getUserDisplayNameSync(contactName, displayName);
      resolveUserDisplayName(contactName).then((resolved) => {
        if (resolved) resolvedDisplayName = resolved;
      });
    } else {
      resolvedDisplayName = displayName || contactName;
    }
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
    {#if isDirect}
      <Avatar userId={contactName} size="lg" />
      {#if isOnline}
        <span
          class="absolute bottom-0 right-0 block h-3.5 w-3.5 rounded-full ring-2 ring-white bg-green-500"
        ></span>
      {/if}
    {:else}
      <div
        class="w-12 h-12 rounded-2xl shadow-sm ring-1 ring-white/20 flex-shrink-0 bg-cn-dark text-cn-yellow flex items-center justify-center"
      >
        <Users size={22} />
      </div>
    {/if}
  </div>

  <!-- Info -->
  <div class="flex-1 min-w-0">
    <div class="flex justify-between items-center mb-1 gap-2">
      <span class="text-cn-dark truncate {unreadCount > 0 ? 'font-extrabold' : 'font-bold'}"
        >{effectiveDisplayName}</span
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
