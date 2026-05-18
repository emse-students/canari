<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import Avatar from '../shared/Avatar.svelte';
  import MessageBubble from '../messages/MessageBubble.svelte';
  import type { ChatMessage, MessageReaction } from '$lib/types';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { ChevronUp } from '@lucide/svelte';

  interface MessageGroup {
    type: 'date_separator' | 'time_separator' | 'message';
    date?: string;
    time?: string;
    message?: ChatMessage;
  }

  interface Props {
    /** Slice of message groups currently rendered in the DOM. */
    visibleMessageGroups: MessageGroup[];
    /** Number of groups hidden above the render window (older messages). */
    hiddenGroupCount: number;
    /** Callback to expand the render window upwards or load older messages from DB. */
    loadOlderGroups: () => void;
    /** Whether the local DB may have messages older than those currently in memory. */
    hasMoreInDb?: boolean;
    /** Active search term used to highlight matching text in messages. */
    searchQuery?: string;
    /** Map of emoji reactions keyed by message ID. */
    messageReactions?: Record<string, MessageReaction[]> | Map<string, MessageReaction[]>;
    /** Callback fired when the user chooses to reply to a message. */
    onReply?: (message: ChatMessage) => void;
    /** Callback to scroll/jump to a specific message by ID. */
    onNavigateToMessage?: (messageId: string) => void;
    /** Callback fired when the user adds an emoji reaction to a message. */
    onReact?: (messageId: string, emoji: string) => void;
    /** Callback to delete a message by ID. */
    onDelete?: (messageId: string) => void;
    /** Callback to edit a message by ID with new text. */
    onEdit?: (messageId: string, text: string) => void;
    /** Timestamp (ms) when the current conversation was opened; messages newer than this animate in. */
    switchTime: number;
    /** ID of the currently authenticated user, used to determine message ownership. */
    currentUserId?: string;
    /** JWT auth token forwarded to message bubbles for media decryption. */
    authToken: string;
  }

  let {
    visibleMessageGroups,
    hiddenGroupCount,
    loadOlderGroups,
    hasMoreInDb = false,
    searchQuery = '',
    messageReactions,
    onReply,
    onNavigateToMessage,
    onReact,
    onDelete,
    onEdit,
    switchTime,
    currentUserId = '',
    authToken,
  }: Props = $props();

  let resolvedSenderNames = $state<Record<string, string>>({});

  // Dernier message envoyé par l'utilisateur (statut Envoi / Envoyé).
  const lastOwnMessageId = $derived(
    [...visibleMessageGroups]
      .reverse()
      .find((g) => g.type === 'message' && g.message?.isOwn && !g.message?.isSystem)?.message?.id ??
      null
  );

  // Dernier message envoyé lu par au moins un interlocuteur (indicateur « Lu »).
  const lastReadOwnMessageId = $derived(
    [...visibleMessageGroups]
      .reverse()
      .find(
        (g) =>
          g.type === 'message' &&
          g.message?.isOwn &&
          !g.message?.isSystem &&
          (g.message.readBy?.length ?? 0) > 0
      )?.message?.id ?? null
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
      if (
        group.type !== 'message' ||
        !group.message ||
        group.message.isOwn ||
        group.message.isSystem
      ) {
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

<!-- Bouton de chargement de l'historique (Sticky) -->
{#if hiddenGroupCount > 0 || hasMoreInDb}
  <div class="sticky top-2 z-10 flex justify-center mb-4 mt-2">
    <button
      type="button"
      onclick={loadOlderGroups}
      class="group inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-white/70 dark:bg-black/40 backdrop-blur-md border border-black/5 dark:border-white/10 text-[0.75rem] font-bold text-text-muted hover:text-text-main hover:bg-white/90 dark:hover:bg-black/60 transition-all shadow-sm hover:shadow-md active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
    >
      <ChevronUp size={14} class="group-hover:-translate-y-0.5 transition-transform" />
      {#if hiddenGroupCount > 0}
        Charger l'historique ({hiddenGroupCount})
      {:else}
        Charger l'historique
      {/if}
    </button>
  </div>
{/if}

<div class="flex flex-col gap-1 pb-4">
  {#each visibleMessageGroups as group, index (group.type === 'message' ? group.message?.id : `${group.type}-${index}`)}
    <!-- Séparateur de Date -->
    {#if group.type === 'date_separator'}
      <div class="flex justify-center my-5">
        <div
          data-chat-date-separator={group.date}
          class="px-4 py-1.5 bg-white/50 dark:bg-black/30 rounded-full text-[0.65rem] text-text-main font-bold uppercase tracking-widest border border-black/5 dark:border-white/10 backdrop-blur-md shadow-sm"
        >
          {group.date}
        </div>
      </div>

      <!-- Séparateur de Temps (Heure) -->
    {:else if group.type === 'time_separator'}
      <div class="flex justify-center my-3">
        <div class="px-2 py-0.5 text-[0.65rem] font-semibold text-text-muted/70 tracking-wider">
          {group.time}
        </div>
      </div>

      <!-- Message -->
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
            {onReact}
            {currentUserId}
            shouldAnimate={msg.timestamp.getTime() > switchTime}
            {authToken}
          />
        </div>
      {:else}
        <div class="flex gap-2.5 {msg.isOwn ? 'justify-end' : 'justify-start'} w-full">
          <!-- Avatar de l'expéditeur (uniquement pour les messages reçus) -->
          {#if !msg.isOwn}
            <div class="w-8 shrink-0 flex flex-col justify-end pb-1">
              {#if groupPosition === 'end' || groupPosition === 'single'}
                <Avatar userId={msg.senderId} size="sm" />
              {/if}
            </div>
          {/if}

          <!-- Conteneur Bulle + Nom -->
          <div
            class="flex min-w-0 flex-col {msg.isOwn
              ? 'items-end'
              : 'items-start'} max-w-[85%] md:max-w-[70%] lg:max-w-[65%]"
          >
            <!-- Nom de l'expéditeur -->
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
              {onNavigateToMessage}
              {onReact}
              {onDelete}
              {onEdit}
              {currentUserId}
              shouldAnimate={msg.timestamp.getTime() > switchTime}
              searchTerm={searchQuery}
              {authToken}
            />
          </div>
        </div>
      {/if}
    {/if}
  {/each}
</div>
