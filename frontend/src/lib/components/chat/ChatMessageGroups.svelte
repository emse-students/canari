<script lang="ts">
  import Avatar from '../shared/Avatar.svelte';
  import MessageBubble from '../messages/MessageBubble.svelte';
  import type { ChatMessage, MessageReaction } from '$lib/types';

  interface MessageGroup {
    type: 'date_separator' | 'time_separator' | 'message';
    date?: string;
    time?: string;
    message?: ChatMessage;
  }

  interface Props {
    visibleMessageGroups: MessageGroup[];
    hiddenGroupCount: number;
    loadOlderGroups: () => void;
    messageReactions?: Record<string, MessageReaction[]> | Map<string, MessageReaction[]>;
    onReply?: (message: ChatMessage) => void;
    onNavigateToMessage?: (messageId: string) => void;
    onReact?: (messageId: string, emoji: string) => void;
    onDelete?: (messageId: string) => void;
    onEdit?: (messageId: string, text: string) => void;
    switchTime: number;
    authToken: string;
  }

  let {
    visibleMessageGroups,
    hiddenGroupCount,
    loadOlderGroups,
    messageReactions,
    onReply,
    onNavigateToMessage,
    onReact,
    onDelete,
    onEdit,
    switchTime,
    authToken,
  }: Props = $props();
</script>

{#if hiddenGroupCount > 0}
  <div class="sticky top-2 z-10 flex justify-center mb-1">
    <button
      type="button"
      onclick={loadOlderGroups}
      class="px-3 py-1 rounded-full bg-[var(--surface-elevated)]/85 backdrop-blur border border-cn-border text-xs text-text-main hover:bg-[var(--surface-elevated)] transition-colors shadow-sm"
    >
      Charger les messages precedents ({hiddenGroupCount})
    </button>
  </div>
{/if}

{#each visibleMessageGroups as group, index (group.type === 'message' ? group.message?.id : `${group.type}-${index}`)}
  {#if group.type === 'date_separator'}
    <div class="flex justify-center my-3">
      <div
        class="px-3 py-1 bg-[var(--surface-elevated)]/85 rounded-full text-xs text-cn-muted font-medium border border-cn-border/70 backdrop-blur"
      >
        {group.date}
      </div>
    </div>
  {:else if group.type === 'time_separator'}
    <div class="flex justify-center my-2">
      <div class="px-2 py-0.5 text-[0.65rem] text-cn-muted/80">
        {group.time}
      </div>
    </div>
  {:else if group.type === 'message' && group.message}
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
    {@const showSender = !msg.isOwn && groupPosition !== 'middle' && groupPosition !== 'end'}

    {#if msg.isSystem}
      <div class="flex justify-center my-2">
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
          {onReact}
          shouldAnimate={msg.timestamp.getTime() > switchTime}
          {authToken}
        />
      </div>
    {:else}
      <div class="flex gap-2 {msg.isOwn ? 'justify-end' : 'justify-start'}">
        {#if !msg.isOwn}
          <div class="flex flex-col items-center gap-1" style="width: 28px;">
            {#if showSender}
              <Avatar userId={msg.senderId} size="sm" />
            {:else}
              <div class="w-6"></div>
            {/if}
          </div>
        {/if}

        <div
          class="flex flex-col {msg.isOwn ? 'items-end' : 'items-start'} max-w-[88%] md:max-w-[75%]"
        >
          {#if showSender}
            <div class="text-xs text-cn-muted px-2 mb-1 font-medium">
              {msg.senderId}
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
            isEdited={msg.isEdited}
            editedAt={msg.editedAt}
            isDeleted={msg.isDeleted}
            {groupPosition}
            onReply={onReply ? () => onReply?.(msg) : undefined}
            {onNavigateToMessage}
            {onReact}
            {onDelete}
            {onEdit}
            shouldAnimate={msg.timestamp.getTime() > switchTime}
            {authToken}
          />
        </div>
      </div>
    {/if}
  {/if}
{/each}
