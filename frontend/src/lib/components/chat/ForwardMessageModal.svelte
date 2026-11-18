<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import ConversationPickList from '$lib/components/shared/ConversationPickList.svelte';
  import { Forward, Send } from '@lucide/svelte';
  import {
    missingPeerNameIds,
    shareCandidates,
    type ShareCandidate,
    type WorkspaceLike,
    forwardPickerOrder,
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
  // labelled with its community, since several salons share a name (`shareCandidates`). MOST RECENT
  // FIRST, like the conversation list and every other share surface, so the conversation the member
  // just left leads; a typed search is a list to scan, so it reads alphabetically (lead, 2026-11-12).
  const candidates = $derived(
    shareCandidates({
      conversations,
      currentUserId,
      workspaces: channelWorkspaces,
      peerNames: resolvedPeerNames,
      query,
      excludeKey,
      order: forwardPickerOrder(query),
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
  <!-- One untitled section: the forward picker is one list (the shared rows, `ConversationPickList`). -->
  <ConversationPickList
    bind:query
    searchPlaceholder={m.chat_search_discussion_placeholder()}
    searchLabel={m.chat_search_discussion_label()}
    sections={[{ id: 'all', title: null, rows: candidates }]}
    emptyText={m.chat_no_discussion_found()}
    onpick={pick}
    rowAttrs={(cand) => ({ 'aria-current': isPreselected(cand) ? 'true' : undefined })}
    rowClass={(cand) => (isPreselected(cand) ? 'ring-accent-icon bg-accent/10 ring-2' : '')}
  >
    {#snippet trailing()}
      {#if variant === 'share'}
        <Send size={16} class="text-text-muted shrink-0" />
      {:else}
        <Forward size={16} class="text-text-muted shrink-0" />
      {/if}
    {/snippet}
  </ConversationPickList>
</Modal>
