<script lang="ts">
  import { format } from 'date-fns';
  import { fly } from 'svelte/transition';
  import { Reply, Smile } from 'lucide-svelte';
  import { clickOutside } from '$lib/actions/clickOutside';
  import 'emoji-picker-element';

  interface MessageReaction {
    emoji: string;
    userId: string;
  }

  interface Props {
    messageId: string;
    senderId: string;
    content: string;
    timestamp: Date;
    isOwn: boolean;
    isSystem?: boolean;
    replyTo?: {
      id: string;
      senderId: string;
      content: string;
    };
    reactions?: MessageReaction[];
    onReply?: (messageId: string) => void;
    onReact?: (messageId: string, emoji: string) => void;
  }

  let {
    messageId,
    senderId: _senderId,
    content,
    timestamp,
    isOwn,
    isSystem = false,
    replyTo,
    reactions = [],
    onReply,
    onReact,
  }: Props = $props();

  let showEmojiPicker = $state(false);

  // Group reactions by emoji
  const groupedReactions = $derived(
    reactions.reduce(
      (acc, r) => {
        if (!acc[r.emoji]) acc[r.emoji] = [];
        acc[r.emoji].push(r.userId);
        return acc;
      },
      {} as Record<string, string[]>
    )
  );

  function handleEmojiClick(emoji: string) {
    onReact?.(messageId, emoji);
    showEmojiPicker = false;
  }

  function attachEmojiPicker(node: HTMLElement) {
    const handleEmoji = (event: any) => {
      handleEmojiClick(event.detail.unicode);
    };
    node.addEventListener('emoji-click', handleEmoji);
    return {
      destroy() {
        node.removeEventListener('emoji-click', handleEmoji);
      },
    };
  }
</script>

<!-- System message (centered, gray) -->
{#if isSystem}
  <div class="flex w-full justify-center my-2">
    <div class="px-4 py-1.5 bg-gray-100 rounded-full text-xs text-gray-600 text-center max-w-md">
      {content}
    </div>
  </div>
{:else}
  <!-- Regular message bubble -->
  <div class="flex w-full {isOwn ? 'justify-end' : 'justify-start'} group">
    <div
      use:clickOutside={() => (showEmojiPicker = false)}
      class="flex flex-col gap-1 max-w-[75%] relative"
    >
      <div
        in:fly={{ y: 5, duration: 200 }}
        class="px-5 py-3 rounded-[1.25rem] {isOwn
          ? 'bg-cn-yellow text-cn-dark rounded-br-sm'
          : 'bg-white text-cn-dark border border-cn-border rounded-bl-sm'}"
      >
        {#if replyTo}
          <div class="mb-2 pb-2 border-l-4 border-gray-400 pl-3 text-xs opacity-70">
            <div class="font-semibold">{replyTo.senderId}</div>
            <div class="truncate">{replyTo.content}</div>
          </div>
        {/if}

        <p class="text-base leading-relaxed break-words">{content}</p>

        <div class="flex items-center justify-between mt-2 gap-2">
          <span class="text-[0.65rem] opacity-70">
            {format(timestamp, 'HH:mm')}
          </span>

          <!-- Action buttons (show on hover) -->
          <div class="opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
            {#if onReply}
              <button
                onclick={() => onReply?.(messageId)}
                class="p-1 rounded hover:bg-black/10 transition-colors"
                aria-label="Répondre"
              >
                <Reply size={14} />
              </button>
            {/if}
            {#if onReact}
              <button
                onclick={() => {
                  showEmojiPicker = !showEmojiPicker;
                }}
                class="p-1 rounded hover:bg-black/10 transition-colors"
                aria-label="Réagir"
              >
                <Smile size={14} />
              </button>
            {/if}
          </div>
        </div>
      </div>

      <!-- Reactions display (grouped) -->
      {#if Object.keys(groupedReactions).length > 0}
        <div class="flex gap-1 flex-wrap px-2">
          {#each Object.entries(groupedReactions) as [emoji, users] (emoji)}
            <button
              class="flex items-center gap-1 px-2 py-0.5 bg-gray-100 hover:bg-gray-200 rounded-full text-xs transition-colors"
              onclick={() => handleEmojiClick(emoji)}
              title={users.join(', ')}
            >
              <span>{emoji}</span>
              <span class="text-gray-600">{users.length}</span>
            </button>
          {/each}
        </div>
      {/if}

      <!-- Emoji picker popup -->
      {#if showEmojiPicker}
        <div
          class="absolute bottom-full mb-1 {isOwn
            ? 'right-0'
            : 'left-0'} bg-white border border-cn-border rounded-lg shadow-xl z-[100] overflow-hidden"
        >
          <emoji-picker use:attachEmojiPicker class="light"></emoji-picker>
        </div>
      {/if}
    </div>
  </div>
{/if}
