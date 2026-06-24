<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import Avatar from '../shared/Avatar.svelte';
  import MessageBubble from '../messages/MessageBubble.svelte';
  import type { ChatMessage, MessageReaction } from '$lib/types';
  import {
    isMessageGroupRow,
    type MessageGroup,
    type MessageGroupMessageRow,
  } from '$lib/utils/messageGrouping';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { Loader2 } from '@lucide/svelte';

  interface Props {
    /** Slice of message groups currently rendered in the DOM. */
    visibleMessageGroups: MessageGroup[];
    /** Whether older messages are currently being fetched (shows a spinner at the top). */
    isLoadingOlder?: boolean;
    /** Active search term used to highlight matching text in messages. */
    searchQuery?: string;
    /** Map of emoji reactions keyed by message ID. */
    messageReactions?: Record<string, MessageReaction[]> | Map<string, MessageReaction[]>;
    /** Callback fired when the user chooses to reply to a message. */
    onReply?: (message: ChatMessage) => void;
    /** Callback fired when the user chooses to forward a message to another conversation. */
    onForward?: (message: ChatMessage) => void;
    /** Callback to scroll/jump to a specific message by ID. */
    onNavigateToMessage?: (messageId: string) => void;
    /** Callback fired when the user adds an emoji reaction to a message. */
    onReact?: (messageId: string, emoji: string) => void;
    /** Callback fired when the user votes on a poll message (channels only). */
    onVotePoll?: (messageId: string, optionIds: string[]) => void;
    /** Callback to delete a message by ID. */
    onDelete?: (messageId: string) => void;
    /** Callback to edit a message by ID with new text. */
    onEdit?: (messageId: string, text: string) => void;
    /** Callback to toggle a message's pinned state. Omit to hide the pin action. */
    onTogglePin?: (messageId: string) => void;
    /** IDs of pinned messages in this conversation. */
    pinnedIds?: string[];
    /** Timestamp (ms) when the current conversation was opened; messages newer than this animate in. */
    switchTime: number;
    /** ID of the currently authenticated user, used to determine message ownership. */
    currentUserId?: string;
    /** JWT auth token forwarded to message bubbles for media decryption. */
    authToken: string;
    /** When true, suppresses sender names (conversation is 1-to-1). */
    isDirect?: boolean;
    /** When true, enables mobile-specific interactions in message bubbles. */
    isMobile?: boolean;
  }

  let {
    visibleMessageGroups,
    isLoadingOlder = false,
    searchQuery = '',
    messageReactions,
    onReply,
    onForward,
    onNavigateToMessage,
    onReact,
    onVotePoll,
    onDelete,
    onEdit,
    onTogglePin,
    pinnedIds = [],
    switchTime,
    currentUserId = '',
    authToken,
    isDirect = false,
    isMobile = false,
  }: Props = $props();

  const pinnedSet = $derived(new Set(pinnedIds));

  let resolvedSenderNames = $state<Record<string, string>>({});

  // Last message sent by the current user (Send / Sent status).
  const lastOwnMessageId = $derived(
    [...visibleMessageGroups]
      .reverse()
      .find(
        (g): g is MessageGroupMessageRow =>
          isMessageGroupRow(g) && g.message.isOwn && !g.message.isSystem
      )?.message.id ?? null
  );

  // Last sent message read by at least one recipient (Read indicator).
  const lastReadOwnMessageId = $derived(
    [...visibleMessageGroups]
      .reverse()
      .find(
        (g): g is MessageGroupMessageRow =>
          isMessageGroupRow(g) &&
          g.message.isOwn &&
          !g.message.isSystem &&
          (g.message.readBy?.length ?? 0) > 0
      )?.message.id ?? null
  );

  function firstNameOnly(value: string): string {
    const cleaned = value.trim();
    if (!cleaned) return value;
    if (cleaned.includes('@')) {
      return cleaned.split('@')[0];
    }
    const parts = cleaned.split(/\s+/).filter(Boolean);
    return parts[0] || cleaned;
  }

  $effect(() => {
    const senderIds = new SvelteSet<string>();
    for (const group of visibleMessageGroups) {
      if (!isMessageGroupRow(group) || group.message.isOwn || group.message.isSystem) {
        continue;
      }
      senderIds.add(group.message.senderId);
    }

    for (const senderId of senderIds) {
      if (!resolvedSenderNames[senderId]) {
        const cached = getUserDisplayNameSync(senderId, senderId);
        if (cached !== senderId) {
          resolvedSenderNames = { ...resolvedSenderNames, [senderId]: cached };
        }
      }
      resolveUserDisplayName(senderId).then((resolved) => {
        if (!resolved || resolvedSenderNames[senderId] === resolved) return;
        resolvedSenderNames = { ...resolvedSenderNames, [senderId]: resolved };
      });
    }
  });
</script>

{#if isLoadingOlder}
  <div class="flex justify-center py-3">
    <Loader2 size={18} class="animate-spin text-text-muted" />
  </div>
{/if}

<div class="flex flex-col gap-1 pb-4">
  {#each visibleMessageGroups as group, index (group?.type === 'message' ? group.message?.id : `${group?.type ?? ''}-${index}`)}
    <!-- Svelte 5 teardown race: group can be null when the {#key} parent destroys this component
         while the {#each} key expression is still being evaluated. All accesses use ?. -->
    <!-- Date separator. -->
    {#if group?.type === 'date_separator'}
      <div class="flex justify-center my-5">
        <div
          data-chat-date-separator={group.date}
          class="px-4 py-1.5 bg-white/50 dark:bg-black/30 rounded-full text-[0.65rem] text-text-main font-bold uppercase tracking-widest border border-black/5 dark:border-white/10 backdrop-blur-md shadow-sm"
        >
          {group.date}
        </div>
      </div>

      <!-- Time separator (hour). -->
    {:else if group?.type === 'time_separator'}
      <div class="flex justify-center my-3">
        <div class="px-2 py-0.5 text-[0.65rem] font-semibold text-text-muted/70 tracking-wider">
          {group.time}
        </div>
      </div>

      <!-- Message -->
    {:else if group?.type === 'message' && group.message}
      {@const msg = group.message}
      {@const reactions =
        messageReactions instanceof Map
          ? messageReactions.get(msg.id) || []
          : messageReactions?.[msg.id] || []}
      {@const prevGroup = index > 0 ? visibleMessageGroups[index - 1] : null}
      {@const prevMsg = prevGroup?.type === 'message' ? prevGroup.message : null}
      {@const nextGroup =
        index < visibleMessageGroups.length - 1 ? visibleMessageGroups[index + 1] : null}
      {@const nextMsg = nextGroup?.type === 'message' ? nextGroup.message : null}
      {@const continuesFromPrev =
        !!prevMsg &&
        !msg.isSystem &&
        !prevMsg.isSystem &&
        prevMsg.senderId === msg.senderId &&
        prevMsg.isOwn === msg.isOwn}
      {@const continuesToNext =
        !!nextMsg &&
        !msg.isSystem &&
        !nextMsg.isSystem &&
        nextMsg.senderId === msg.senderId &&
        nextMsg.isOwn === msg.isOwn}
      {@const groupPosition = continuesFromPrev
        ? continuesToNext
          ? 'middle'
          : 'end'
        : continuesToNext
          ? 'start'
          : 'single'}
      {@const showSender = !msg.isOwn && !isDirect && groupPosition !== 'middle' && groupPosition !== 'end'}

      {#if msg.isSystem}
        <div class="flex justify-center my-3">
          <MessageBubble
            messageId={msg.id}
            senderId={msg.senderId}
            content={msg.content}
            timestamp={msg.timestamp}
            isOwn={msg.isOwn}
            isSystem={msg.isSystem}
            replyTo={msg.replyTo}
            {reactions}
            onReply={onReply ? () => onReply?.(msg) : undefined}
            onForward={onForward ? () => onForward?.(msg) : undefined}
            {onReact}
            {currentUserId}
            shouldAnimate={msg.timestamp.getTime() > switchTime}
            {authToken}
            {isMobile}
          />
        </div>
      {:else}
        <div class="flex gap-2.5 {msg.isOwn ? 'justify-end' : 'justify-start'} w-full">
          <!-- Sender avatar (received messages only). -->
          {#if !msg.isOwn}
            <div class="w-8 shrink-0 flex flex-col justify-end pb-1">
              {#if groupPosition === 'end' || groupPosition === 'single'}
                <Avatar userId={msg.senderId} size="sm" />
              {/if}
            </div>
          {/if}

          <!-- Bubble + sender name container. -->
          <div
            class="flex min-w-0 flex-col {msg.isOwn
              ? 'items-end'
              : 'items-start'} max-w-[85%] md:max-w-[70%] lg:max-w-[65%]"
          >
            <!-- Sender name. -->
            {#if showSender && !msg.isSystem}
              <div class="text-[0.75rem] text-text-muted px-1 mb-1 font-bold tracking-wide">
                <a
                  href="/profile/{encodeURIComponent(msg.senderId)}"
                  class="hover:text-text-main transition-colors"
                  onclick={(e) => e.stopPropagation()}
                >
                  {firstNameOnly(resolvedSenderNames[msg.senderId] || msg.senderId)}
                </a>
              </div>
            {/if}

            <MessageBubble
              messageId={msg.id}
              senderId={msg.senderId}
              content={msg.content}
              timestamp={msg.timestamp}
              isOwn={msg.isOwn}
              isSystem={msg.isSystem}
              replyTo={msg.replyTo}
              {reactions}
              readBy={msg.readBy}
              readAt={msg.readAt}
              isLastOwn={msg.id === lastOwnMessageId}
              isReadReceiptAnchor={msg.id === lastReadOwnMessageId}
              isEdited={msg.isEdited}
              editedAt={msg.editedAt}
              isDeleted={msg.isDeleted}
              status={msg.status}
              {groupPosition}
              onReply={onReply ? () => onReply?.(msg) : undefined}
            onForward={onForward ? () => onForward?.(msg) : undefined}
              {onNavigateToMessage}
              {onReact}
              {onVotePoll}
              {onDelete}
              {onEdit}
              {onTogglePin}
              pinned={pinnedSet.has(msg.id)}
              {currentUserId}
              shouldAnimate={msg.timestamp.getTime() > switchTime}
              searchTerm={searchQuery}
              {authToken}
              {isMobile}
            />
          </div>
        </div>
      {/if}
    {/if}
  {/each}
</div>
