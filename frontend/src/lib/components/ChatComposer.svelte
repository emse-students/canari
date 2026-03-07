<script lang="ts">
  import { Send } from "lucide-svelte";
  import { tick } from "svelte";

  interface Props {
    messageText: string;
    onMessageChange: (value: string) => void;
    onSend: () => void;
  }

  let { messageText, onMessageChange, onSend }: Props = $props();
  let textareaEl: HTMLTextAreaElement;

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  $effect(() => {
    if (textareaEl) {
      textareaEl.style.height = "auto";
      textareaEl.style.height = textareaEl.scrollHeight + "px";
    }
  });
</script>

<footer class="px-6 py-4 bg-white border-t border-cn-border">
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
</footer>
