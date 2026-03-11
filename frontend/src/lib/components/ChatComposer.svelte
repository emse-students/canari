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
    onFilesSelected?: (files: File[]) => void;
    pendingFiles?: File[];
    onRemovePendingFile?: (index: number) => void;
    isUploading?: boolean;
  }

  let {
    messageText,
    onMessageChange,
    onSend,
    replyingTo,
    onCancelReply,
    onFilesSelected,
    pendingFiles = [],
    onRemovePendingFile,
    isUploading = false,
  }: Props = $props();

  let textareaEl: HTMLTextAreaElement;
  let fileInput: HTMLInputElement | undefined = $state();
  let isDragOver = $state(false);
  let previewUrls = $state<Record<string, string>>({});
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
    const files = input.files ? Array.from(input.files) : [];
    if (files.length > 0 && onFilesSelected) {
      onFilesSelected(files);
      input.value = '';
    }
  }

  function collectDroppedFiles(event: DragEvent): File[] {
    const dt = event.dataTransfer;
    if (!dt) return [];
    return Array.from(dt.files || []);
  }

  function handleDragOver(event: DragEvent) {
    event.preventDefault();
    isDragOver = true;
  }

  function handleDragLeave(event: DragEvent) {
    event.preventDefault();
    if (!event.currentTarget) return;
    const currentTarget = event.currentTarget as HTMLElement;
    const next = event.relatedTarget as Node | null;
    if (!next || !currentTarget.contains(next)) {
      isDragOver = false;
    }
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    isDragOver = false;
    const files = collectDroppedFiles(event);
    if (files.length > 0 && onFilesSelected) {
      onFilesSelected(files);
    }
  }

  function fileKey(file: File, index: number): string {
    return `${file.name}-${file.size}-${file.lastModified}-${index}`;
  }

  function isImageFile(file: File): boolean {
    return file.type.startsWith('image/');
  }

  function isPdfFile(file: File): boolean {
    return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  }

  function handleVoiceRecording(audioBlob: Blob) {
    if (!onFilesSelected) return;

    // Convert Blob to File with explicit audio/webm type
    const audioFile = new File([audioBlob], `vocal_${Date.now()}.webm`, {
      type: 'audio/webm',
    });

    onFilesSelected([audioFile]);
  }

  async function handleGifSelected(gifUrl: string) {
    if (!onFilesSelected) return;

    try {
      // Download the GIF and convert to File
      const res = await fetch(gifUrl);
      const blob = await res.blob();
      const gifFile = new File([blob], `gif_${Date.now()}.gif`, {
        type: 'image/gif',
      });

      onFilesSelected([gifFile]);
    } catch (error) {
      console.error('Erreur téléchargement GIF:', error);
    }
  }

  $effect(() => {
    if (textareaEl) {
      textareaEl.style.height = '40px';
      textareaEl.style.height = `${Math.max(textareaEl.scrollHeight, 40)}px`;
    }
  });

  $effect(() => {
    if (replyingTo && textareaEl) {
      textareaEl.focus();
    }
  });

  $effect(() => {
    const previous = previewUrls;
    const next: Record<string, string> = {};

    pendingFiles.forEach((file, index) => {
      const key = fileKey(file, index);
      if (!isImageFile(file) && !isPdfFile(file)) return;
      next[key] = previous[key] ?? URL.createObjectURL(file);
    });

    for (const [key, url] of Object.entries(previous)) {
      if (!next[key]) URL.revokeObjectURL(url);
    }

    previewUrls = next;
  });
</script>

<footer class="bg-[var(--surface-elevated)] border-t border-cn-border">
  {#if replyingTo}
    <div
      class="px-3 md:px-6 py-2 bg-cn-bg border-b border-cn-border flex items-center justify-between"
    >
      <div class="flex-1 min-w-0">
        <div class="text-xs font-semibold text-text-main">
          Répondre à {replyingTo.senderId}
        </div>
        <div class="text-sm text-text-muted truncate">
          {replyingTo.content}
        </div>
      </div>
      {#if onCancelReply}
        <button
          onclick={onCancelReply}
          class="p-1 text-text-muted hover:text-cn-dark transition-colors flex-shrink-0"
          aria-label="Annuler la réponse"
        >
          <X size={16} />
        </button>
      {/if}
    </div>
  {/if}

  <div class="px-3 md:px-6 py-3 md:py-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
    {#if pendingFiles.length > 0}
      <div class="mb-2">
        <div class="text-[0.7rem] text-text-muted mb-1">
          {pendingFiles.length} fichier(s) en attente
        </div>
        <div class="flex flex-wrap gap-2">
          {#each pendingFiles as file, index (`${file.name}-${index}`)}
            {@const key = fileKey(file, index)}
            <div
              class="relative rounded-2xl bg-cn-bg border border-cn-border overflow-hidden w-24 h-24"
            >
              {#if isImageFile(file) && previewUrls[key]}
                <img src={previewUrls[key]} alt={file.name} class="w-full h-full object-cover" />
              {:else if isPdfFile(file) && previewUrls[key]}
                <div class="w-full h-full bg-[var(--cn-surface)]">
                  <embed src={previewUrls[key]} type="application/pdf" class="w-full h-full" />
                </div>
              {:else}
                <div
                  class="w-full h-full flex flex-col items-center justify-center gap-1 px-2 text-text-muted"
                >
                  <FileText size={16} />
                  <span class="text-[0.6rem] text-center leading-tight line-clamp-2"
                    >{file.name}</span
                  >
                </div>
              {/if}

              <div
                class="absolute inset-x-0 bottom-0 bg-black/55 text-white text-[0.55rem] px-1.5 py-1 truncate"
                title={file.name}
              >
                {file.name}
              </div>
              {#if onRemovePendingFile}
                <button
                  type="button"
                  class="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 hover:bg-black/75 inline-flex items-center justify-center text-white"
                  onclick={() => onRemovePendingFile(index)}
                  aria-label="Retirer le fichier"
                >
                  <X size={12} />
                </button>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <div
      role="group"
      aria-label="Zone de saisie et depot de fichiers"
      class="relative max-w-full flex items-center gap-2 md:gap-3 bg-cn-bg p-2.5 md:p-3 rounded-3xl overflow-x-hidden border {isDragOver
        ? 'border-cn-yellow'
        : 'border-transparent'}"
      ondragover={handleDragOver}
      ondragleave={handleDragLeave}
      ondrop={handleDrop}
    >
      {#if isDragOver}
        <div
          class="absolute left-1/2 -translate-x-1/2 -translate-y-11 px-3 py-1 rounded-full bg-cn-dark text-white text-xs pointer-events-none"
        >
          Deposez vos fichiers ici
        </div>
      {/if}

      <button
        onclick={() => fileInput?.click()}
        disabled={isUploading}
        title="Envoyer une image, vidéo ou fichier"
        aria-label="Joindre un fichier"
        class="w-10 h-10 md:w-11 md:h-11 text-text-muted rounded-full flex items-center justify-center flex-shrink-0 hover:text-cn-dark hover:bg-[color-mix(in_srgb,var(--cn-bg)_85%,var(--cn-dark)_15%)] transition-colors disabled:opacity-40"
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
        multiple
        accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.zip"
        class="hidden"
        onchange={handleFileChange}
      />

      <textarea
        bind:this={textareaEl}
        value={messageText}
        oninput={(e) => onMessageChange(e.currentTarget.value)}
        onkeydown={handleKeydown}
        placeholder="Message..."
        rows="1"
        class="flex-1 min-w-0 bg-transparent border-none resize-none outline-none font-normal text-[0.95rem] md:text-base px-2 py-2 leading-6 max-h-32"
      ></textarea>
      <button
        onclick={onSend}
        disabled={(!messageText.trim() && pendingFiles.length === 0) || isUploading}
        aria-label="Envoyer le message"
        class="w-10 h-10 md:w-11 md:h-11 bg-cn-dark text-cn-yellow rounded-full flex items-center justify-center flex-shrink-0 transition-transform hover:scale-105 active:scale-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
      >
        <Send size={20} />
      </button>
    </div>
  </div>
</footer>
