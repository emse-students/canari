<script lang="ts">
  import { Send, Paperclip, X } from 'lucide-svelte';
  import VoiceRecorder from './VoiceRecorder.svelte';
  import GifPicker from './GifPicker.svelte';

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
    onFileSelected?: (file: File) => void;
    isUploading?: boolean;
  }

  let {
    messageText,
    onMessageChange,
    onSend,
    replyingTo,
    onCancelReply,
    onFileSelected,
    isUploading = false,
  }: Props = $props();

  let textareaEl: HTMLTextAreaElement;
  let fileInput: HTMLInputElement | undefined = $state();
  const isVoiceRecordingSupported =
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
    if (e.key === 'Escape' && replyingTo) {
      onCancelReply?.();
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

  function handleVoiceRecording(audioBlob: Blob) {
    if (!onFileSelected) return;

    // Convert Blob to File with explicit audio/webm type
    const audioFile = new File([audioBlob], `vocal_${Date.now()}.webm`, {
      type: 'audio/webm',
    });

    onFileSelected(audioFile);
  }

  async function handleGifSelected(gifUrl: string) {
    if (!onFileSelected) return;

    try {
      // Download the GIF and convert to File
      const res = await fetch(gifUrl);
      const blob = await res.blob();
      const gifFile = new File([blob], `gif_${Date.now()}.gif`, {
        type: 'image/gif',
      });

      onFileSelected(gifFile);
    } catch (error) {
      console.error('Erreur téléchargement GIF:', error);
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

<footer class="bg-[var(--surface-elevated)] border-t border-cn-border">
  {#if replyingTo}
    <div
      class="px-3 md:px-6 py-2 bg-cn-bg border-b border-cn-border flex items-center justify-between"
    >
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

  <div class="px-3 md:px-6 py-3 md:py-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
    <div class="max-w-full flex items-end gap-2 md:gap-3 bg-cn-bg p-2.5 md:p-3 rounded-3xl overflow-x-hidden">
      <button
        onclick={() => fileInput?.click()}
        disabled={isUploading}
        title="Envoyer une image, vidéo ou fichier"
        aria-label="Joindre un fichier"
        class="w-10 h-10 md:w-11 md:h-11 text-gray-400 rounded-full flex items-center justify-center flex-shrink-0 hover:text-cn-dark hover:bg-gray-200 transition-colors disabled:opacity-40"
      >
        {#if isUploading}
          <svg class="animate-spin w-5 h-5" viewBox="0 0 24 24" fill="none">
            <circle
              class="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              stroke-width="4"
            />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
          </svg>
        {:else}
          <Paperclip size={20} />
        {/if}
      </button>

      {#if isVoiceRecordingSupported}
        <VoiceRecorder onRecordingComplete={handleVoiceRecording} />
      {/if}

      <GifPicker onGifSelected={handleGifSelected} />

      <input
        bind:this={fileInput}
        type="file"
        accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.zip"
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
        class="flex-1 min-w-0 bg-transparent border-none resize-none outline-none font-normal text-[0.95rem] md:text-base px-2 py-1 max-h-32"
      ></textarea>
      <button
        onclick={onSend}
        disabled={!messageText.trim() || isUploading}
        aria-label="Envoyer le message"
        class="w-10 h-10 md:w-11 md:h-11 bg-cn-dark text-cn-yellow rounded-full flex items-center justify-center flex-shrink-0 transition-transform hover:scale-105 active:scale-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
      >
        <Send size={20} />
      </button>
    </div>
  </div>
</footer>
