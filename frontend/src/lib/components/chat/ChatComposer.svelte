<script lang="ts">
  import { Send, Paperclip, X, FileText, UploadCloud, Loader2 } from '@lucide/svelte';
  import { untrack, tick, onMount } from 'svelte';
  import { slide, fade, scale } from 'svelte/transition';
  import { getPreviewText, parseEnvelope } from '$lib/envelope';
  import VoiceRecorder from './VoiceRecorder.svelte';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import MentionComposerInput from '$lib/components/shared/MentionComposerInput.svelte';
  import type { PendingMediaFile } from '$lib/media';
  import { mediaAspectStyle } from '$lib/utils/mediaLayout';
  import { isTauriRuntime } from '$lib/utils/openExternal';

  interface ReplyTo {
    id: string;
    senderId: string;
    content: string;
  }

  interface Props {
    /** Current value of the message text area (controlled). */
    messageText: string;
    /** Callback fired on each keystroke in the text area. */
    onMessageChange: (value: string) => void;
    /** Callback to submit the composed message. */
    onSend: () => void;
    /** Optional callback reporting text-area focus state changes. */
    onFocusChange?: (focused: boolean) => void;
    /** Message being replied to, shown as a preview above the input. */
    replyingTo?: ReplyTo | null;
    /** Callback to cancel the current reply. */
    onCancelReply?: () => void;
    /** Callback fired when the user selects or drops files to attach. */
    onFilesSelected?: (files: File[]) => void;
    /** Files staged for sending but not yet uploaded. */
    pendingFiles?: PendingMediaFile[];
    /** Callback to remove a staged file by its index. */
    onRemovePendingFile?: (index: number) => void;
    /** Whether an upload is currently in progress (disables the send button). */
    isUploading?: boolean;
    /** When true, the composer is read-only (MLS catch-up in progress). */
    interactionLocked?: boolean;
  }

  let {
    messageText,
    onMessageChange,
    onSend,
    onFocusChange,
    replyingTo,
    onCancelReply,
    onFilesSelected,
    pendingFiles = [],
    onRemovePendingFile,
    isUploading = false,
    interactionLocked = false,
  }: Props = $props();

  let mentionComposer = $state<MentionComposerInput | null>(null);
  let composerFooter = $state<HTMLElement | null>(null);
  let fileInput: HTMLInputElement | undefined = $state();
  let isDragOver = $state(false);
  let previewUrls = $state<Record<string, string>>({});
  const hasMediaRecorder =
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;
  let isMobileViewport = $state(false);
  const isVoiceRecordingSupported = $derived(
    // Show on mobile/coarse-pointer devices AND on Tauri desktop where MediaRecorder is available.
    // Hidden on regular desktop Web browsers to keep the composer uncluttered.
    hasMediaRecorder && (isMobileViewport || isTauriRuntime())
  );

  const isSendDisabled = $derived(
    interactionLocked ||
      (!messageText.trim() && pendingFiles.length === 0) ||
      isUploading
  );

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

  let replySenderDisplayName = $state('');

  $effect(() => {
    if (!replyingTo?.senderId) {
      replySenderDisplayName = '';
      return;
    }

    const senderId = replyingTo.senderId;
    replySenderDisplayName = getUserDisplayNameSync(senderId, senderId);
    resolveUserDisplayName(senderId).then((resolved) => {
      if (resolved && replyingTo?.senderId === senderId) {
        replySenderDisplayName = resolved;
      }
    });
  });

  function handleComposerKeydown(e: KeyboardEvent) {
    // Guard: !e.isComposing prevents Enter from sending when the IME is selecting a suggestion.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!isSendDisabled) {
        mentionComposer?.commitComposition();
        onSend();
        mentionComposer?.clearEditor();
        tick().then(() => mentionComposer?.focusEditor());
      }
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
    const composer = mentionComposer;
    void messageText;
    tick().then(() => {
      const el = composer?.getEditorElement();
      if (!el) return;
      el.style.height = '44px';
      el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 160)}px`;
    });
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
    if (replyingTo) {
      mentionComposer?.focusEditor();
    }
  });

  /** Publishes composer stack height for message list padding (--chat-composer-height). */
  onMount(() => {
    const footer = composerFooter;
    if (!footer || typeof document === 'undefined') return;

    const publishHeight = () => {
      document.documentElement.style.setProperty(
        '--chat-composer-height',
        `${Math.ceil(footer.offsetHeight)}px`
      );
    };

    publishHeight();
    const ro = new ResizeObserver(publishHeight);
    ro.observe(footer);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty('--chat-composer-height');
    };
  });

  $effect(() => {
    const files = pendingFiles;
    untrack(() => {
      const previous = previewUrls;
      const next: Record<string, string> = {};

      files.forEach((entry, index) => {
        const file = entry.file;
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

<!-- Footer Container -->
<footer class="chat-composer-footer" bind:this={composerFooter}>
  <!-- Zone de Réponse (Reply) -->
  {#if replyingTo}
    <div transition:slide={{ duration: 200, axis: 'y' }} class="pointer-events-auto">
      <div
        class="mx-3 sm:mx-4 md:mx-6 mb-3 flex items-center justify-between bg-white/85 dark:bg-[#151B2C]/85 backdrop-blur-2xl border border-black/5 dark:border-white/10 rounded-2xl p-3 md:p-4 shadow-lg relative overflow-hidden"
      >
        <div
          class="absolute left-0 top-0 bottom-0 w-1.5 bg-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.6)]"
        ></div>
        <div class="flex-1 min-w-0 pl-1.5">
          <div
            class="text-xs font-bold text-amber-600 dark:text-amber-500 mb-0.5 flex items-center gap-1.5"
          >
            <span class="truncate">Répondre à {replySenderDisplayName || replyingTo.senderId}</span>
          </div>
          <div class="text-[0.85rem] font-medium text-text-muted truncate leading-snug">
            {replyPreviewText}
          </div>
        </div>
        {#if onCancelReply}
          <button
            onclick={onCancelReply}
            class="p-2 ml-2 rounded-full bg-black/5 dark:bg-white/5 text-text-muted hover:text-text-main hover:bg-black/10 dark:hover:bg-white/10 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 flex-shrink-0 active:scale-95"
            aria-label="Annuler la réponse"
          >
            <X size={16} strokeWidth={2.5} />
          </button>
        {/if}
      </div>
    </div>
  {/if}

  <div class="px-3 sm:px-4 md:px-6 pointer-events-auto flex flex-col gap-2">
    <!-- Zone des Fichiers en attente -->
    {#if pendingFiles.length > 0}
      <div transition:slide={{ duration: 200, axis: 'y' }} class="w-full">
        <div class="text-[0.7rem] font-bold uppercase tracking-wider text-text-muted mb-2 px-1">
          {pendingFiles.length} fichier{pendingFiles.length > 1 ? 's' : ''} en attente
        </div>
        <div class="flex flex-wrap gap-3">
          {#each pendingFiles as entry, index (`${entry.file.name}-${index}`)}
            {@const file = entry.file}
            {@const key = fileKey(file, index)}
            {@const thumbAspect =
              entry.width && entry.height
                ? mediaAspectStyle(entry.width, entry.height)
                : 'aspect-ratio: 1'}
            <div
              transition:scale={{ duration: 200, start: 0.9 }}
              class="relative rounded-[1rem] bg-white/90 dark:bg-[#151B2C]/90 backdrop-blur-xl border border-black/5 dark:border-white/10 overflow-hidden w-20 sm:w-24 shadow-md group/file"
              style="{thumbAspect}; max-height: 6rem;"
            >
              {#if isImageFile(file) && previewUrls[key]}
                <img src={previewUrls[key]} alt={file.name} class="w-full h-full object-cover" />
              {:else if isPdfFile(file) && previewUrls[key]}
                <div class="w-full h-full bg-white/50 dark:bg-black/50">
                  <embed
                    src={previewUrls[key]}
                    type="application/pdf"
                    class="w-full h-full pointer-events-none"
                  />
                </div>
              {:else}
                <div
                  class="w-full h-full flex flex-col items-center justify-center gap-1.5 px-2 text-text-muted bg-black/5 dark:bg-white/5"
                >
                  <FileText size={20} strokeWidth={1.5} />
                  <span
                    class="text-[0.6rem] sm:text-[0.65rem] font-medium text-center leading-tight line-clamp-2 px-1 break-all"
                  >
                    {file.name}
                  </span>
                </div>
              {/if}

              <!-- Overlay Gradient et Nom du fichier -->
              <div
                class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent pt-4 pb-1.5 px-2 pointer-events-none"
              >
                <div
                  class="text-white text-[0.55rem] sm:text-[0.6rem] font-medium truncate drop-shadow-md"
                  title={file.name}
                >
                  {file.name}
                </div>
              </div>

              <!-- Bouton de suppression -->
              {#if onRemovePendingFile}
                <button
                  type="button"
                  class="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/50 backdrop-blur-md hover:bg-red-500 inline-flex items-center justify-center text-white shadow-sm opacity-100 sm:opacity-0 sm:group-hover/file:opacity-100 transition-all duration-200 outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-red-500 scale-90 hover:scale-105 active:scale-95"
                  onclick={() => onRemovePendingFile(index)}
                  aria-label="Retirer le fichier"
                  title="Retirer"
                >
                  <X size={14} strokeWidth={2.5} />
                </button>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Barre de saisie principale -->
    <div
      role="group"
      aria-label="Zone de saisie et dépôt de fichiers"
      class="chat-composer-panel {isDragOver ? 'is-dragover' : ''}"
      ondragover={!isMobileViewport ? handleDragOver : undefined}
      ondragleave={!isMobileViewport ? handleDragLeave : undefined}
      ondrop={!isMobileViewport ? handleDrop : undefined}
    >
      <!-- Badge de Drag & Drop au-dessus -->
      {#if isDragOver}
        <div
          transition:fade={{ duration: 150 }}
          class="absolute left-1/2 -translate-x-1/2 -translate-y-16 z-10 pointer-events-none"
        >
          <span
            class="px-4 py-2.5 bg-amber-500 text-[#151B2C] font-extrabold rounded-full shadow-xl shadow-amber-500/20 text-sm flex items-center gap-2 whitespace-nowrap"
          >
            <UploadCloud size={18} strokeWidth={2.5} /> Déposez vos fichiers ici
          </span>
        </div>
      {/if}

      <!-- Bouton Pièce Jointe -->
      <div class="shrink-0">
        <button
          onclick={() => fileInput?.click()}
          disabled={isUploading || interactionLocked}
          title="Envoyer une image, vidéo ou fichier"
          aria-label="Joindre un fichier"
          class="chat-composer-icon-button"
        >
          {#if isUploading}
            <Loader2 class="animate-spin w-5 h-5 text-amber-500" strokeWidth={2.5} />
          {:else}
            <Paperclip size={20} strokeWidth={2} />
          {/if}
        </button>
      </div>

      <!-- Enregistreur Vocal (Mobile uniquement) -->
      {#if isVoiceRecordingSupported}
        <div class="shrink-0">
          <VoiceRecorder onRecordingComplete={handleVoiceRecording} />
        </div>
      {/if}

      <input
        bind:this={fileInput}
        type="file"
        multiple
        accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.zip"
        class="hidden"
        onchange={handleFileChange}
      />

      <!-- Zone de Texte auto-extensible -->
      <MentionComposerInput
        bind:this={mentionComposer}
        value={messageText}
        onchange={onMessageChange}
        class="flex-1 min-w-0"
        editorClass="chat-composer-textarea"
        placeholder={interactionLocked ? 'Synchronisation MLS…' : 'Écrivez un message...'}
        minHeight="44px"
        disabled={interactionLocked}
        onfocus={() => onFocusChange?.(true)}
        onblur={() => onFocusChange?.(false)}
        onkeydown={handleComposerKeydown}
        onpaste={handlePaste}
      />

      <!-- Bouton Envoyer Dynamique -->
      <div class="shrink-0 pr-1">
        <button
          onmousedown={(e) => e.preventDefault()}
          onclick={() => { mentionComposer?.commitComposition(); onSend(); mentionComposer?.clearEditor(); }}
          disabled={isSendDisabled}
          aria-label="Envoyer le message"
          class="chat-composer-send-button {isSendDisabled ? 'is-disabled' : ''}"
        >
          <!-- Léger décalage de l'icône Send pour un centrage optique parfait -->
          <Send size={18} strokeWidth={2.5} class={isSendDisabled ? '' : 'ml-0.5 mt-0.5'} />
        </button>
      </div>
    </div>
  </div>
</footer>
