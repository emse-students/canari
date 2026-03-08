<script lang="ts">
  import { Send, Paperclip } from 'lucide-svelte';

  interface Props {
    messageText: string;
    onMessageChange: (value: string) => void;
    onSend: () => void;
    onFileSelected?: (file: File) => void;
    isUploading?: boolean;
  }

  let { messageText, onMessageChange, onSend, onFileSelected, isUploading = false }: Props = $props();
  let textareaEl: HTMLTextAreaElement;
  let fileInput: HTMLInputElement | undefined = $state();

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file && onFileSelected) {
      onFileSelected(file);
      input.value = '';
    }
  }

  $effect(() => {
    if (textareaEl) {
      textareaEl.style.height = 'auto';
      textareaEl.style.height = textareaEl.scrollHeight + 'px';
    }
  });
</script>

<footer class="px-6 py-4 bg-white border-t border-cn-border">
  <div class="flex items-end gap-3 bg-cn-bg p-3 rounded-3xl">
    <!-- Attachment button -->
    <button
      onclick={() => fileInput?.click()}
      disabled={isUploading}
      title="Envoyer une image ou un fichier"
      aria-label="Joindre un fichier"
      class="w-11 h-11 text-gray-400 rounded-full flex items-center justify-center flex-shrink-0 hover:text-cn-dark hover:bg-gray-200 transition-colors disabled:opacity-40"
    >
      {#if isUploading}
        <svg class="animate-spin w-5 h-5" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
        </svg>
      {:else}
        <Paperclip size={20} />
      {/if}
    </button>

    <!-- Hidden file input – accepts images, video, and any file -->
    <input
      bind:this={fileInput}
      type="file"
      accept="image/*,video/*,application/pdf,.doc,.docx,.zip"
      class="hidden"
      onchange={handleFileChange}
    />

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
      disabled={!messageText.trim() || isUploading}
      aria-label="Envoyer le message"
      class="w-11 h-11 bg-cn-dark text-cn-yellow rounded-full flex items-center justify-center flex-shrink-0 transition-transform hover:scale-105 active:scale-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
    >
      <Send size={20} />
    </button>
  </div>
</footer>
