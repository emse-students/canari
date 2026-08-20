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
    /**
     * Whether {@link displayName} is a real name rather than the "unknown user" placeholder.
     * When `false`, the tile ignores it and shows its own asynchronously resolved name instead -
     * a placeholder is non-empty, so without this flag it would win over the real answer forever.
     */
    displayNameResolved?: boolean;
    /** Type of conversation, determines avatar and presence display logic. */
    conversationType?: 'direct' | 'group' | 'channel';
    /** Serialised envelope of the last message, used to render the preview text. */
    lastMessage?: string;
    /** Whether the MLS session for this conversation is fully established. */
    isReady: boolean;
    /**
     * Whether the conversation is removed (deleted by a peer / exclusion / pending local
     * deletion). A `removed` group is NOT syncing: the "Sync" badge is not shown (misleading -
     * the group is dead, not in transit). Defaults to `false`.
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
    displayNameResolved = true,
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
    displayNameResolved &&
      displayName &&
      displayName !== contactName &&
      !(isDirect && isCanonicalDirectKey(displayName))
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
  class="group flex w-full items-center gap-4 rounded-[1.25rem] p-3.5 text-left transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-[0.98]
    {isSelected
    ? 'border border-black/5 bg-white/60 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-black/40'
    : unreadCount > 0
      ? 'border border-transparent bg-white/30 hover:bg-white/50 dark:bg-white/5 dark:hover:bg-white/10'
      : 'border border-transparent hover:bg-white/40 dark:hover:bg-black/20'}
    animate-rise-in"
>
  <!-- Avatar / group icon zone -->
  <div class="relative flex-shrink-0">
    {#if isDirect}
      <Avatar userId={contactName} size="lg" fallbackLabel={effectiveDisplayName} />
      {#if isOnline}
        <span
          class="absolute right-0 bottom-0 block h-3.5 w-3.5 rounded-full bg-green-500 shadow-sm ring-2 ring-white dark:ring-zinc-900"
        ></span>
      {/if}
    {:else if conversationType === 'channel'}
      <div class="text-text-muted flex h-12 w-12 items-center justify-center">
        <Hash size={22} strokeWidth={2.5} />
      </div>
    {:else}
      <GroupAvatar {imageMediaId} name={displayName} variant="group" size="lg" />
    {/if}
  </div>

  <!-- Info zone (name, preview, badges) -->
  <div class="flex min-w-0 flex-1 flex-col justify-center">
    <div class="mb-0.5 flex items-center justify-between gap-3">
      <!-- Conversation name -->
      <span
        class="text-text-main truncate text-[0.95rem] {unreadCount > 0
          ? 'font-extrabold'
          : 'font-bold'}"
      >
        {effectiveDisplayName}
      </span>

      <!-- Badges area (unread, sync) -->
      <div class="flex flex-shrink-0 items-center gap-2">
        {#if !isReady && !isRemoved}
          <span
            class="rounded-full border border-amber-500/20 bg-amber-500/15 px-2 py-0.5 text-[0.6rem] font-bold tracking-wider text-amber-700 uppercase dark:bg-amber-500/20 dark:text-amber-400"
          >
            {m.chat_sync_badge_label()}
          </span>
        {/if}
        {#if unreadCount > 0}
          <span
            class="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-red-500 px-1.5 text-[0.7rem] font-bold text-white shadow-sm shadow-red-500/20"
            aria-label={m.chat_unread_messages_label({ count: unreadCount })}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        {/if}
      </div>
    </div>

    <!-- Last message preview -->
    <div
      class="mt-0.5 truncate text-sm {unreadCount > 0
        ? 'text-text-main font-semibold'
        : 'text-text-muted opacity-90'}"
    >
      {previewText || m.chat_e2e_established_preview()}
    </div>
  </div>
</button>
