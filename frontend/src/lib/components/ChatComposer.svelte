<script lang="ts">
  import { Send, Paperclip, X, FileText } from 'lucide-svelte';
  import VoiceRecorder from './VoiceRecorder.svelte';
  import GifPicker from './GifPicker.svelte';
  import { parseEnvelope, getPreviewText } from '$lib/envelope';

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

  let previewUrl: string | null = $state(null);

  $effect(() => {
    if (pendingMediaFile && pendingMediaFile.type.startsWith('image/')) {
      const url = URL.createObjectURL(pendingMediaFile);
      previewUrl = url;
      return () => URL.revokeObjectURL(url);
    } else {
      previewUrl = null;
    }
  });

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

<footer
  class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-white/10 to-transparent pb-6 pt-10 z-20 pointer-events-none"
>
  <div class="px-4 pointer-events-auto">
    {#if replyingTo}
      <div
        class="mb-2 max-w-4xl mx-auto flex items-center justify-between bg-white/90 backdrop-blur-md border border-gray-100 rounded-xl p-3 shadow-lg relative overflow-hidden"
      >
        <div class="absolute left-0 top-0 bottom-0 w-1 bg-cn-yellow"></div>
        <div class="flex-1 min-w-0 ml-3">
          <div class="text-xs font-bold text-gray-800 flex items-center gap-1.5">
            <span class="text-cn-yellow">Réponse à</span>
            {replyingTo.senderId}
          </div>
          <div class="text-sm text-gray-500 truncate mt-0.5">
            {getPreviewText(parseEnvelope(replyingTo.content))}
          </div>
        </div>
        {#if onCancelReply}
          <button
            onclick={onCancelReply}
            class="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-black/5 rounded-full transition-colors"
            aria-label="Annuler la réponse"
          >
            <X size={16} />
          </button>
        {/if}
      </div>
    {/if}

    <div
      class="max-w-4xl mx-auto flex flex-col bg-white/75 backdrop-blur-xl border border-white/40 shadow-[0_8px_30px_rgb(0,0,0,0.04)] rounded-[1.5rem] transition-all focus-within:bg-white/95 focus-within:shadow-[0_8px_40px_rgb(0,0,0,0.08)]"
    >
      {#if pendingMediaFile}
        <div
          class="mx-3 mt-3 mb-1 p-3 bg-white/60 backdrop-blur-sm rounded-xl border border-white/50 flex justify-between animate-in fade-in slide-in-from-bottom-2 {previewUrl
            ? 'max-w-xs items-start'
            : 'w-64 items-center'}"
        >
          {#if previewUrl}
            <div class="flex-1 min-w-0 flex flex-col gap-2">
              <img
                src={previewUrl}
                alt="Aperçu"
                class="w-full h-auto max-h-48 rounded-lg object-contain bg-black/5 hover:bg-black/10 transition-colors border-0"
              />
              <div class="flex flex-col min-w-0 px-1">
                <span class="text-sm font-medium text-gray-700 truncate"
                  >{pendingMediaFile.name}</span
                >
                <span class="text-[10px] text-gray-400"
                  >{formatFileSize(pendingMediaFile.size)}</span
                >
              </div>
            </div>
          {:else}
            <div class="flex items-center gap-3 overflow-hidden flex-1">
              <div
                class="w-10 h-10 bg-blue-500/10 text-blue-600 rounded-lg flex items-center justify-center flex-shrink-0"
              >
                <FileText size={20} />
              </div>
              <div class="flex flex-col min-w-0">
                <span class="text-sm font-medium text-gray-700 truncate max-w-[200px]"
                  >{pendingMediaFile.name}</span
                >
                <span class="text-[10px] text-gray-400"
                  >{formatFileSize(pendingMediaFile.size)}</span
                >
              </div>
            </div>
          {/if}

          {#if onCancelMedia}
            <button
              onclick={onCancelMedia}
              class="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors ml-2 flex-shrink-0"
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
          class="w-10 h-10 text-gray-500 hover:text-gray-800 hover:bg-black/5 rounded-full flex items-center justify-center transition-colors disabled:opacity-50"
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
          class="flex-1 bg-transparent border-none resize-none outline-none text-base py-2.5 max-h-32 min-h-[44px] placeholder-gray-500 text-gray-800"
        ></textarea>

        <button
          onclick={onSend}
          disabled={(!messageText.trim() && !pendingMediaFile) || isUploading}
          class="w-10 h-10 bg-cn-dark text-cn-yellow rounded-full flex items-center justify-center flex-shrink-0 transition-all hover:scale-105 active:scale-95 disabled:opacity-50 disabled:scale-100 shadow-md hover:shadow-lg disabled:shadow-none bg-gradient-to-br from-cn-dark to-gray-800"
        >
          <Send size={18} class="ml-0.5" />
        </button>
      </div>
    </div>
  </div>
</footer>
