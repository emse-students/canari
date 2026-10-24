<script lang="ts">
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import { Search, Forward, Hash, Send } from '@lucide/svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import GroupAvatar from '$lib/components/shared/GroupAvatar.svelte';
  import {
    missingPeerNameIds,
    shareCandidates,
    type ShareCandidate,
    type WorkspaceLike,
  } from '$lib/sharing/shareDestinations';
  import { resolveUserDisplayName } from '$lib/utils/users/displayName';
  import type { Conversation } from '$lib/types';
  import { m } from '$lib/paraglide/messages';

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
    /**
     * Called with the target conversation key when the user picks a destination. `label` is the
     * name as displayed in this list - the caller must not fall back to `conversation.name`, which
     * for a DM is the peer's raw user id.
     */
    onSelect: (key: string, conversation: Conversation, label: string) => void;
    /**
     * What the pick is for: relaying a message (`forward`, the default) or sending content another
     * app shared into Canari (`share`). Only the title and the row icon differ.
     */
    variant?: 'forward' | 'share';
    /**
     * A conversation id to offer first and highlighted - the suggestion the member picked in
     * Android's share sheet (sharing lot S5). Only a row this list holds is highlighted; the member
     * still taps it.
     */
    preselectedId?: string | null;
  }

  let {
    open,
    conversations,
    excludeKey = null,
    currentUserId,
    channelWorkspaces = [],
    onClose,
    onSelect,
    variant = 'forward',
    preselectedId = null,
  }: Props = $props();

  let query = $state('');

  /**
   * Peer names fetched for DM rows the synchronous resolver could not name.
   *
   * Without this the picker lists "Utilisateur inconnu" for every DM whose profile is not already
   * cached - and worse, the search box filters on that same label, so the one action the modal
   * exists for (find a person, forward to them) is impossible. The list is built synchronously
   * because it must render at once; the names simply arrive after it.
   */
  let resolvedPeerNames = $state<Record<string, string>>({});

  $effect(() => {
    // No local de-duplication: resolveUserDisplayName already answers from its cache and shares
    // one in-flight promise per id, and this effect never reads `resolvedPeerNames`, so writing
    // it cannot re-trigger the loop.
    for (const id of missingPeerNameIds(conversations, currentUserId, excludeKey)) {
      void resolveUserDisplayName(id).then((name) => {
        if (name) resolvedPeerNames = { ...resolvedPeerNames, [id]: name };
      });
    }
  });

  // All threads (DMs, groups, channels) except the source conversation, never a raw id; a salon is
  // labelled with its community, since several salons share a name (`shareCandidates`).
  const candidates = $derived(
    shareCandidates({
      conversations,
      currentUserId,
      workspaces: channelWorkspaces,
      peerNames: resolvedPeerNames,
      query,
      excludeKey,
      order: 'alphabetical',
      preselectedId,
    })
  );

  function isPreselected(cand: ShareCandidate): boolean {
    return preselectedId !== null && cand.conversation.id === preselectedId;
  }

  function pick(cand: ShareCandidate) {
    onSelect(cand.key, cand.conversation, cand.label);
    query = '';
  }
</script>

<Modal
  {open}
  title={variant === 'share' ? m.share_modal_title() : m.chat_forward_modal_title()}
  {onClose}
>
  <div class="flex flex-col gap-3">
    <div class="relative">
      <Search size={16} class="text-text-muted absolute top-1/2 left-3 -translate-y-1/2" />
      <input
        type="text"
        bind:value={query}
        placeholder={m.chat_search_discussion_placeholder()}
        aria-label={m.chat_search_discussion_label()}
        class="border-cn-border text-text-main focus:border-cn-yellow w-full rounded-xl border bg-(--cn-surface) py-2.5 pr-3 pl-9 text-sm outline-none"
      />
    </div>

    <div class="-mx-1 flex max-h-[50vh] flex-col gap-0.5 overflow-y-auto px-1">
      {#if candidates.length === 0}
        <p class="text-text-muted py-8 text-center text-sm">{m.chat_no_discussion_found()}</p>
      {:else}
        {#each candidates as cand (cand.key)}
          <button
            type="button"
            onclick={() => pick(cand)}
            aria-current={isPreselected(cand) ? 'true' : undefined}
            class="flex items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5
 {isPreselected(cand) ? 'ring-cn-yellow bg-cn-yellow/10 ring-2' : ''}"
          >
            {#if cand.conversation.conversationType === 'direct'}
              <Avatar
                userId={cand.conversation.directPeerId ?? cand.conversation.contactName}
                size="md"
                fallbackLabel={cand.label}
              />
            {:else if cand.conversation.conversationType === 'channel'}
              <div class="text-text-muted flex h-8 w-8 shrink-0 items-center justify-center">
                <Hash size={18} strokeWidth={2.5} />
              </div>
            {:else}
              <GroupAvatar
                imageMediaId={cand.conversation.imageMediaId}
                name={cand.label}
                variant="group"
                size="md"
              />
            {/if}
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="text-text-main truncate text-sm font-semibold">{cand.label}</span>
              {#if cand.community}
                <span class="text-text-muted flex items-center gap-1 truncate text-xs">
                  <Hash size={11} class="shrink-0" />
                  <EmojiText text={cand.community} />
                </span>
              {/if}
            </span>
            {#if variant === 'share'}
              <Send size={16} class="text-text-muted shrink-0" />
            {:else}
              <Forward size={16} class="text-text-muted shrink-0" />
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  </div>
</Modal>
