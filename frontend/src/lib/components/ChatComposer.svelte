<script lang="ts">
  import { Send, Paperclip, X, FileText } from 'lucide-svelte';
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
    pendingMediaFile?: File | null;
    onCancelMedia?: () => void;
    isUploading?: boolean;
  }

  let {
    messageText,
    onMessageChange,
    onSend,
    replyingTo,
    onCancelReply,
    onFileSelected,
    pendingMediaFile = null,
    onCancelMedia,
    isUploading = false,
  }: Props = $props();

  let textareaEl: HTMLTextAreaElement;
  let fileInput: HTMLInputElement | undefined = $state();

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

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  }

  $effect(() => {
    // dependency on messageText to trigger resize
    messageText = messageText;
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

<footer class="bg-white border-t border-cn-border pb-4 pt-2">
  <div class="px-4">
    {#if replyingTo}
      <div
        class="mb-2 max-w-4xl mx-auto flex items-center justify-between bg-gray-50 border-l-4 border-cn-yellow rounded-r-lg p-2 shadow-sm"
      >
        <div class="flex-1 min-w-0 ml-2">
          <div class="text-xs font-bold text-gray-700">Réponse à {replyingTo.senderId}</div>
          <div class="text-sm text-gray-500 truncate">{replyingTo.content}</div>
        </div>
        {#if onCancelReply}
          <button
            onclick={onCancelReply}
            class="p-1 text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="Annuler la réponse"
          >
            <X size={16} />
          </button>
        {/if}
      </div>
    {/if}

    <div
      class="max-w-4xl mx-auto flex flex-col bg-cn-bg rounded-[1.5rem] border border-transparent focus-within:border-gray-200 transition-colors shadow-sm"
    >
      {#if pendingMediaFile}
        <div
          class="mx-3 mt-3 mb-1 p-2 bg-white rounded-xl shadow-sm border border-gray-100 flex items-center justify-between animate-in fade-in slide-in-from-bottom-2"
        >
          <div class="flex items-center gap-3 overflow-hidden">
            <div
              class="w-10 h-10 bg-blue-50 text-blue-500 rounded-lg flex items-center justify-center flex-shrink-0"
            >
              <FileText size={20} />
            </div>
            <div class="flex flex-col min-w-0">
              <span class="text-sm font-medium text-gray-700 truncate max-w-[200px]"
                >{pendingMediaFile.name}</span
              >
              <span class="text-[10px] text-gray-400">{formatFileSize(pendingMediaFile.size)}</span>
            </div>
          </div>
          {#if onCancelMedia}
            <button
              onclick={onCancelMedia}
              class="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors"
              aria-label="Retirer le fichier"
            >
              <X size={16} />
            </button>
          {/if}
        </div>
      {/if}

      <div class="flex items-end gap-2 p-2">
        <button
          onclick={() => fileInput?.click()}
          disabled={isUploading}
          title="Joindre un fichier"
          class="w-10 h-10 text-gray-400 hover:text-gray-600 hover:bg-gray-200/50 rounded-full flex items-center justify-center transition-colors disabled:opacity-50"
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

        <VoiceRecorder onRecordingComplete={handleVoiceRecording} />
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
          placeholder={pendingMediaFile ? 'Ajouter une légende...' : 'Message sécurisé...'}
          rows="1"
          class="flex-1 bg-transparent border-none resize-none outline-none text-base py-2.5 max-h-32 min-h-[44px] placeholder-gray-400"
        ></textarea>

        <button
          onclick={onSend}
          disabled={(!messageText.trim() && !pendingMediaFile) || isUploading}
          class="w-10 h-10 bg-cn-dark text-cn-yellow rounded-full flex items-center justify-center flex-shrink-0 transition-all hover:scale-105 active:scale-95 disabled:opacity-50 disabled:scale-100 shadow-md hover:shadow-lg disabled:shadow-none"
        >
          <Send size={18} class="ml-0.5" />
        </button>
      </div>
    </div>
  </div>
</footer>
