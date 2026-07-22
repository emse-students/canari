<script lang="ts">
  import { Hash } from '@lucide/svelte';
  import Avatar from '../shared/Avatar.svelte';
  import GroupAvatar from '../shared/GroupAvatar.svelte';
  import { getPreviewText, parseEnvelope } from '$lib/envelope';
  import { presenceMap, watchUsers, unwatchUsers } from '$lib/stores/presenceStore';
  import { onMount } from 'svelte';
  import { extractMentionUserIds } from '$lib/utils/mentions';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { isCanonicalDirectKey } from '$lib/utils/chat/conversations';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Raw contact/user ID used for presence lookup and direct-message routing. */
    contactName: string;
    /** Human-readable display name shown in the tile. */
    displayName: string;
    /** Type of conversation, determines avatar and presence display logic. */
    conversationType?: 'direct' | 'group' | 'channel';
    /** Serialised envelope of the last message, used to render the preview text. */
    lastMessage?: string;
    /** Whether the MLS session for this conversation is fully established. */
    isReady: boolean;
    /**
     * Whether the conversation is removed (supprimee par un pair / exclusion / suppression locale
     * en attente). Un groupe `removed` n'est PAS en cours de synchro : on ne montre pas le badge
     * "Sync" (trompeur - le groupe est mort, pas en transit). Defaut `false`.
     */
    isRemoved?: boolean;
    /** Whether this tile is the currently active conversation. */
    isSelected: boolean;
    /** Number of unread messages to display as a badge. */
    unreadCount?: number;
    /** Optional media ID for the group avatar image. Ignored for channels (name only, no avatar). */
    imageMediaId?: string | null;
    /** Callback fired when the user clicks the tile. */
    onClick: () => void;
  }

  let {
    contactName,
    displayName,
    conversationType = 'group',
    lastMessage,
    isReady,
    isRemoved = false,
    isSelected,
    unreadCount = 0,
    imageMediaId = null,
    onClick,
  }: Props = $props();

  // Only direct conversations have a real peer user ID - group/channel names are
  // display names, not user IDs, so we must not use them for presence or avatars.
  const isDirect = $derived(conversationType === 'direct');

  let previewText = $state<string | null>(null);
  let isOnline = $derived(isDirect ? $presenceMap[contactName] || false : false);
  let resolvedDisplayName = $state('');

  const effectiveDisplayName = $derived(
    displayName && displayName !== contactName && !(isDirect && isCanonicalDirectKey(displayName))
      ? displayName
      : resolvedDisplayName
  );

  onMount(() => {
    // Only poll presence for real user IDs (direct conversations).
    if (isDirect) {
      watchUsers([contactName]);
      return () => unwatchUsers([contactName]);
    }
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

  $effect(() => {
    const raw = lastMessage;
    if (!raw) {
      previewText = null;
      return;
    }
    const env = parseEnvelope(raw);
    previewText = getPreviewText(env);

    const source = env.kind === 'text' ? env.text : env.kind === 'media' ? (env.caption ?? '') : '';
    const mentionIds = extractMentionUserIds(source);
    if (mentionIds.length === 0) return;

    void Promise.all(mentionIds.map((id) => resolveUserDisplayName(id))).then(() => {
      if (lastMessage !== raw) return;
      previewText = getPreviewText(parseEnvelope(raw));
    });
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
  <!-- Avatar / group icon zone -->
  <div class="relative flex-shrink-0">
    {#if isDirect}
      <Avatar userId={contactName} size="lg" fallbackLabel={effectiveDisplayName} />
      {#if isOnline}
        <span
          class="absolute bottom-0 right-0 block h-3.5 w-3.5 rounded-full ring-2 ring-white dark:ring-zinc-900 bg-green-500 shadow-sm"
        ></span>
      {/if}
    {:else if conversationType === 'channel'}
      <div class="w-12 h-12 flex items-center justify-center text-text-muted">
        <Hash size={22} strokeWidth={2.5} />
      </div>
    {:else}
      <GroupAvatar {imageMediaId} name={displayName} variant="group" size="lg" />
    {/if}
  </div>

  <!-- Info zone (name, preview, badges) -->
  <div class="flex-1 min-w-0 flex flex-col justify-center">
    <div class="flex justify-between items-center mb-0.5 gap-3">
      <!-- Conversation name -->
      <span
        class="text-[0.95rem] text-text-main truncate {unreadCount > 0
          ? 'font-extrabold'
          : 'font-bold'}"
      >
        {effectiveDisplayName}
      </span>

      <!-- Badges area (unread, sync) -->
      <div class="flex items-center gap-2 flex-shrink-0">
        {#if !isReady && !isRemoved}
          <span
            class="bg-amber-500/15 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-500/20 text-[0.6rem] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider"
          >
            {m.chat_sync_badge_label()}
          </span>
        {/if}
        {#if unreadCount > 0}
          <span
            class="min-w-[1.25rem] h-5 px-1.5 rounded-full bg-red-500 text-white text-[0.7rem] font-bold inline-flex items-center justify-center shadow-sm shadow-red-500/20"
            aria-label={m.chat_unread_messages_label({ count: unreadCount })}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        {/if}
      </div>
    </div>

    <!-- Last message preview -->
    <div
      class="text-sm truncate mt-0.5 {unreadCount > 0
        ? 'text-text-main font-semibold'
        : 'text-text-muted opacity-90'}"
    >
      {previewText || m.chat_e2e_established_preview()}
    </div>
  </div>
</button>
