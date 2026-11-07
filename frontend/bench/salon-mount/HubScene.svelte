<script lang="ts">
  /**
   * The communities hub with a salon pane beside it, as `MainChatPage` lays them out on a phone:
   * the sidebar (rail + salon rows) is hidden while a salon is open. `open()` is the tap on a salon
   * row: the pane takes the salon, the sidebar hides, and the listing hands in fresh objects for the
   * same communities - which is what the boot's listing reconcile does while the member taps.
   */
  import { SvelteMap } from 'svelte/reactivity';
  import Sidebar from '$lib/components/sidebar/Sidebar.svelte';
  import ChatArea from '$lib/components/chat/ChatArea.svelte';
  import type { Conversation } from '$lib/types';

  interface Props {
    /** Communities in the rail. */
    communities: number;
    /** Salons in each community. */
    salons: number;
    /** The salon the open hands to the pane. */
    salon: Conversation;
  }

  let { communities, salons, salon }: Props = $props();

  /** A fresh listing: new objects every call, the same ids and order. */
  const listing = () =>
    Array.from({ length: communities }, (_, c) => ({
      id: `ws-${c}`,
      name: `BancOuverture-${c + 1}`,
      avatarUserId: `ws-${c}`,
      channels: Array.from({ length: salons }, (_, s) => ({
        id: `channel_${c}_${s}`,
        name: s === 0 ? 'general' : `salon-${s}`,
      })),
    }));

  let workspaces = $state(listing());
  let opened = $state<Conversation | null>(null);
  const conversations = new SvelteMap<string, Conversation>();
  const noop = () => {};
  const done = async () => ({ ok: true as const, key: null });

  /** The tap on the first salon of the first community. */
  export function open(): void {
    opened = salon;
    workspaces = listing();
  }
</script>

<div style="display: flex; flex: 1; min-height: 0">
  <Sidebar
    viewMode="communities"
    {conversations}
    channelWorkspaces={workspaces}
    selectedContact={opened ? opened.id : null}
    selectedChannelId={opened ? 'channel_0_0' : ''}
    newContactInput=""
    newGroupInput=""
    onContactInputChange={noop}
    onGroupInputChange={noop}
    onAddContact={done}
    onCreateGroup={done}
    onSelectConversation={noop}
    currentUserId="bench-reader"
    isHidden={opened !== null}
  />
  <!-- Always mounted, as in `MainChatPage`: the open hands it a conversation, it is no mount. -->
  <ChatArea
    conversation={opened}
    currentUserId="bench-reader"
    isChannel
    isHidden={opened === null}
    messageText=""
    onMessageChange={noop}
    bindDraftWriter={() => noop}
    onSend={noop}
    onInviteMembers={noop}
  />
</div>
