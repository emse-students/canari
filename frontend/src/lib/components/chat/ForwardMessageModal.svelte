<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import { Search, Forward, Hash } from '@lucide/svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import GroupAvatar from '$lib/components/shared/GroupAvatar.svelte';
  import { resolveConversationListPresentation } from '$lib/utils/chat/conversations';
  import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
  import type { Conversation } from '$lib/types';
  import { SvelteMap } from 'svelte/reactivity';
  import { m } from '$lib/paraglide/messages';

  /** Minimal community-workspace shape needed to resolve a channel's community. */
  interface WorkspaceLike {
    name: string;
    channels: { id: string }[];
  }

  interface Props {
    open: boolean;
    /** Conversations as [key, conversation] entries (key = conversation map key). */
    conversations: [string, Conversation][];
    /** Conversation key to exclude (the source conversation). */
    excludeKey?: string | null;
    /** Authenticated user ID, used to resolve DM peer display names. */
    currentUserId: string;
    /** Community workspaces, used to label channel (salon) targets with their community. */
    channelWorkspaces?: WorkspaceLike[];
    onClose: () => void;
    /** Called with the target conversation key when the user picks a destination. */
    onSelect: (key: string, conversation: Conversation) => void;
  }

  let {
    open,
    conversations,
    excludeKey = null,
    currentUserId,
    channelWorkspaces = [],
    onClose,
    onSelect,
  }: Props = $props();

  let query = $state('');

  /** Channel conversation ID → community (workspace) name, for disambiguating same-named salons. */
  const channelCommunity = $derived.by(() => {
    const map = new SvelteMap<string, string>();
    for (const ws of channelWorkspaces) {
      for (const ch of ws.channels) map.set(ch.id, ws.name);
    }
    return map;
  });

  interface Candidate {
    key: string;
    conversation: Conversation;
    /** Resolved human-readable name (peer name for DMs, group/channel name otherwise). */
    label: string;
    /** Community name when the target is a channel/salon, else null. */
    community: string | null;
  }

  // All threads (DMs, groups, channels) except the source conversation. Names are resolved via
  // resolveConversationListPresentation so raw IDs are never shown; channels are labelled with
  // their community name because multiple channels can share the same display name.
  const candidates = $derived.by<Candidate[]>(() => {
    const q = query.trim().toLowerCase();
    return conversations
      .filter(([key]) => key !== excludeKey)
      .map(([key, c]): Candidate => {
        const community = isChannelConversationId(c.id)
          ? (channelCommunity.get(c.id) ?? null)
          : null;
        const label = resolveConversationListPresentation(
          {
            id: c.id,
            name: c.name,
            contactName: c.contactName ?? c.id,
            conversationType: c.conversationType,
            directPeerId: c.directPeerId,
          },
          currentUserId
        ).displayName;
        return { key, conversation: c, label, community };
      })
      .filter((cand) => cand.label.trim().length > 0)
      .filter(
        (cand) =>
          !q ||
          cand.label.toLowerCase().includes(q) ||
          (cand.community?.toLowerCase().includes(q) ?? false)
      )
      .sort(
        (a, b) =>
          (a.community ?? '').localeCompare(b.community ?? '') || a.label.localeCompare(b.label)
      );
  });

  function pick(cand: Candidate) {
    onSelect(cand.key, cand.conversation);
    query = '';
  }
</script>

<Modal {open} title={m.chat_forward_modal_title()} {onClose}>
  <div class="flex flex-col gap-3">
    <div class="relative">
      <Search size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
      <input
        type="text"
        bind:value={query}
        placeholder={m.chat_search_discussion_placeholder()}
        aria-label={m.chat_search_discussion_label()}
        class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] py-2.5 pl-9 pr-3 text-sm text-text-main outline-none focus:border-cn-yellow"
      />
    </div>

    <div class="-mx-1 flex max-h-[50vh] flex-col gap-0.5 overflow-y-auto px-1">
      {#if candidates.length === 0}
        <p class="py-8 text-center text-sm text-text-muted">{m.chat_no_discussion_found()}</p>
      {:else}
        {#each candidates as cand (cand.key)}
          <button
            type="button"
            onclick={() => pick(cand)}
            class="flex items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5"
          >
            {#if cand.conversation.conversationType === 'direct'}
              <Avatar
                userId={cand.conversation.directPeerId ?? cand.conversation.contactName}
                size="md"
                fallbackLabel={cand.label}
              />
            {:else}
              <GroupAvatar
                imageMediaId={cand.conversation.imageMediaId}
                name={cand.label}
                variant={cand.conversation.conversationType === 'channel' ? 'channel' : 'group'}
                size="md"
              />
            {/if}
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate text-sm font-semibold text-text-main">{cand.label}</span>
              {#if cand.community}
                <span class="flex items-center gap-1 truncate text-xs text-text-muted">
                  <Hash size={11} class="shrink-0" />
                  {cand.community}
                </span>
              {/if}
            </span>
            <Forward size={16} class="shrink-0 text-text-muted" />
          </button>
        {/each}
      {/if}
    </div>
  </div>
</Modal>
