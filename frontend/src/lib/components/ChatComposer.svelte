<script lang="ts">
  import { Send, X } from 'lucide-svelte';

  interface ReplyTo {
    id: string;
    senderId: string;
    content: string;
  }

  interface Props {
    messageText: string;
    onMessageChange: (value: string) => void;
    onSend: () => void;
    replyingTo?: ReplyTo | null;
    onCancelReply?: () => void;
  }

  let { messageText, onMessageChange, onSend, replyingTo, onCancelReply }: Props = $props();
  let textareaEl: HTMLTextAreaElement;

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
    if (e.key === 'Escape' && replyingTo) {
      onCancelReply?.();
    }
  }

  $effect(() => {
    if (textareaEl) {
      textareaEl.style.height = 'auto';
      textareaEl.style.height = textareaEl.scrollHeight + 'px';
    }
  });

  $effect(() => {
    if (replyingTo && textareaEl) {
      textareaEl.focus();
    }
  });
</script>

<footer class="bg-white border-t border-cn-border">
  {#if replyingTo}
    <div class="px-6 py-2 bg-gray-50 border-b border-cn-border flex items-center justify-between">
      <div class="flex-1 min-w-0">
        <div class="text-xs font-semibold text-gray-600">
          Répondre à {replyingTo.senderId}
        </div>
        <div class="text-sm text-gray-500 truncate">
          {replyingTo.content}
        </div>
      </div>
      {#if onCancelReply}
        <button
          onclick={onCancelReply}
          class="p-1 text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0"
          aria-label="Annuler la réponse"
        >
          <X size={16} />
        </button>
      {/if}
    </div>
  {/if}

  <div class="px-6 py-4">
    <div class="flex items-end gap-3 bg-cn-bg p-3 rounded-3xl">
      <textarea
        bind:this={textareaEl}
        value={messageText}
        oninput={(e) => onMessageChange(e.currentTarget.value)}
        onkeydown={handleKeydown}
        placeholder="Message sécurisé..."
        rows="1"
        class="flex-1 bg-transparent border-none resize-none outline-none font-normal text-base px-2 py-1 max-h-32"
      ></textarea>
      <button
        onclick={onSend}
        disabled={!messageText.trim()}
        aria-label="Envoyer le message"
        class="w-11 h-11 bg-cn-dark text-cn-yellow rounded-full flex items-center justify-center flex-shrink-0 transition-transform hover:scale-105 active:scale-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
      >
        <Send size={20} />
      </button>
    </div>
  </div>
</footer>
