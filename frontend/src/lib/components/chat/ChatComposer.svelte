<script lang="ts">
  import { Send, Paperclip, X, FileText } from 'lucide-svelte';
  import { untrack } from 'svelte';
  import { getPreviewText, parseEnvelope } from '$lib/envelope';
  import VoiceRecorder from './VoiceRecorder.svelte';

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
  const hasMediaRecorder =
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;
  let isMobileViewport = $state(false);
  const isVoiceRecordingSupported = $derived(hasMediaRecorder && isMobileViewport);

  function toReplyPreview(value: string): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= 96) return normalized;
    return `${normalized.slice(0, 93)}...`;
  }

  let replyPreviewText = $derived.by(() => {
    if (!replyingTo || !replyingTo.content) return '';
    try {
      return toReplyPreview(getPreviewText(parseEnvelope(replyingTo.content)));
    } catch {
      return '';
    }
  });

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

  function collectClipboardFiles(event: ClipboardEvent): File[] {
    const dt = event.clipboardData;
    if (!dt) return [];

    const filesFromItems = Array.from(dt.items || [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);

    return filesFromItems;
  }

  function handlePaste(event: ClipboardEvent) {
    if (!onFilesSelected) return;
    const files = collectClipboardFiles(event);
    if (files.length === 0) return;

    event.preventDefault();
    onFilesSelected(files);
  }

  function isImageFile(file: File): boolean {
    return file.type.startsWith('image/');
  }

  function isPdfFile(file: File): boolean {
    return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  }

  function handleVoiceRecording(audioBlob: Blob) {
    if (!onFilesSelected) return;

    const mimeType = audioBlob.type || 'audio/webm';
    const extension = mimeType.includes('mp4')
      ? 'm4a'
      : mimeType.includes('ogg')
        ? 'ogg'
        : mimeType.includes('wav')
          ? 'wav'
          : 'webm';

    const audioFile = new File([audioBlob], `vocal_${Date.now()}.${extension}`, {
      type: mimeType,
    });

    onFilesSelected([audioFile]);
  }

  $effect(() => {
    if (textareaEl) {
      textareaEl.style.height = '40px';
      textareaEl.style.height = `${Math.max(textareaEl.scrollHeight, 40)}px`;
    }
  });

  $effect(() => {
    if (typeof window === 'undefined') return;

    const query = window.matchMedia('(max-width: 768px), (pointer: coarse)');
    const apply = () => {
      isMobileViewport = query.matches;
    };

    apply();
    query.addEventListener('change', apply);
    return () => {
      query.removeEventListener('change', apply);
    };
  });

  $effect(() => {
    if (replyingTo && textareaEl) {
      textareaEl.focus();
    }
  });

  $effect(() => {
    const files = pendingFiles;
    untrack(() => {
      const previous = previewUrls;
      const next: Record<string, string> = {};

      files.forEach((file, index) => {
        const key = fileKey(file, index);
        if (!isImageFile(file) && !isPdfFile(file)) return;
        next[key] = previous[key] ?? URL.createObjectURL(file);
      });

      for (const [key, url] of Object.entries(previous)) {
        if (!next[key]) URL.revokeObjectURL(url);
      }

      previewUrls = next;
    });
  });
</script>

<footer
  class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-white/55 dark:from-black/30 via-white/15 dark:via-black/10 to-transparent pb-[max(0.9rem,env(safe-area-inset-bottom))] pt-8 z-20 pointer-events-none"
>
  {#if replyingTo}
    <div
      class="mx-3 md:mx-6 mb-2 max-w-4xl md:max-w-[unset] flex items-center justify-between bg-white/85 backdrop-blur-md border border-white/60 rounded-xl p-3 shadow-lg pointer-events-auto relative overflow-hidden"
    >
      <div class="absolute left-0 top-0 bottom-0 w-1 bg-cn-yellow"></div>
      <div class="flex-1 min-w-0">
        <div class="text-xs font-semibold text-text-main">
          Répondre à {replyingTo.senderId}
        </div>
        <div class="text-sm text-text-muted truncate">
          {replyPreviewText}
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

  <div class="px-3 md:px-6 pointer-events-auto">
    {#if pendingFiles.length > 0}
      <div class="mb-2">
        <div class="text-[0.7rem] text-text-muted mb-1">
          {pendingFiles.length} fichier(s) en attente
        </div>
        <div class="flex flex-wrap gap-2">
          {#each pendingFiles as file, index (`${file.name}-${index}`)}
            {@const key = fileKey(file, index)}
            <div
              class="relative rounded-2xl bg-white/80 backdrop-blur-sm border border-white/60 overflow-hidden w-24 h-24 shadow-sm"
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
      class="relative max-w-full flex items-center gap-2 md:gap-3 backdrop-blur-md bg-white/50 dark:bg-gray-800/50 p-2.5 md:p-3 rounded-full overflow-x-hidden border border-white/50 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.05)] transition-all {isDragOver
        ? 'ring-2 ring-amber-300/70'
        : ''}"
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
        class="w-10 h-10 md:w-11 md:h-11 text-text-muted rounded-full flex items-center justify-center flex-shrink-0 hover:text-cn-dark hover:bg-black/5 transition-colors disabled:opacity-40"
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
        onpaste={handlePaste}
        placeholder="Message..."
        rows="1"
        class="flex-1 min-w-0 bg-transparent border-none resize-none outline-none font-normal text-[0.95rem] md:text-base px-2 py-2 leading-6 max-h-32 text-gray-800 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-300"
      ></textarea>
      <button
        onclick={onSend}
        disabled={(!messageText.trim() && pendingFiles.length === 0) || isUploading}
        aria-label="Envoyer le message"
        class="w-10 h-10 md:w-11 md:h-11 bg-amber-500 text-white rounded-full flex items-center justify-center flex-shrink-0 transition-transform hover:scale-105 active:scale-100 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
      >
        <Send size={20} />
      </button>
    </div>
  </div>
</footer>
