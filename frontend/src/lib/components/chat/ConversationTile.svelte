<script lang="ts">
  import Avatar from '../shared/Avatar.svelte';
  import GroupAvatar from '../shared/GroupAvatar.svelte';
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
    imageMediaId?: string | null;
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
    imageMediaId = null,
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
  class="w-full p-3.5 flex items-center gap-4 rounded-[1.25rem] transition-all duration-200 text-left outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-[0.98] group
    {isSelected
    ? 'bg-white/60 dark:bg-black/40 border border-black/5 dark:border-white/10 shadow-sm backdrop-blur-md'
    : unreadCount > 0
      ? 'bg-white/30 dark:bg-white/5 hover:bg-white/50 dark:hover:bg-white/10 border border-transparent'
      : 'hover:bg-white/40 dark:hover:bg-black/20 border border-transparent'}
    animate-rise-in"
>
  <!-- Zone Avatar / Icône de Groupe -->
  <div class="relative flex-shrink-0">
    {#if isDirect}
      <Avatar userId={contactName} size="lg" fallbackLabel={effectiveDisplayName} />
      {#if isOnline}
        <span
          class="absolute bottom-0 right-0 block h-3.5 w-3.5 rounded-full ring-2 ring-white dark:ring-zinc-900 bg-green-500 shadow-sm"
        ></span>
      {/if}
    {:else}
      <GroupAvatar
        {imageMediaId}
        name={displayName}
        variant={conversationType === 'channel' ? 'channel' : 'group'}
        size="lg"
      />
    {/if}
  </div>

  <!-- Zone d'Informations (Nom, Aperçu, Badges) -->
  <div class="flex-1 min-w-0 flex flex-col justify-center">
    <div class="flex justify-between items-center mb-0.5 gap-3">
      <!-- Nom de la conversation -->
      <span
        class="text-[0.95rem] text-text-main truncate {unreadCount > 0
          ? 'font-extrabold'
          : 'font-bold'}"
      >
        {effectiveDisplayName}
      </span>

      <!-- Espace Badges (Non lus, Sync) -->
      <div class="flex items-center gap-2 flex-shrink-0">
        {#if !isReady}
          <span
            class="bg-amber-500/15 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-500/20 text-[0.6rem] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider"
          >
            Sync
          </span>
        {/if}
        {#if unreadCount > 0}
          <span
            class="min-w-[1.25rem] h-5 px-1.5 rounded-full bg-red-500 text-white text-[0.7rem] font-bold inline-flex items-center justify-center shadow-sm shadow-red-500/20"
            aria-label={`${unreadCount} message(s) non lu(s)`}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        {/if}
      </div>
    </div>

    <!-- Aperçu du dernier message -->
    <div
      class="text-sm truncate mt-0.5 {unreadCount > 0
        ? 'text-text-main font-semibold'
        : 'text-text-muted opacity-90'}"
    >
      {previewText || 'Canal E2E établi.'}
    </div>
  </div>
</button>
