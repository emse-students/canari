<script lang="ts">
  import {
    Send,
    Paperclip,
    ChevronRight,
    X,
    FileText,
    CloudUpload,
    LoaderCircle,
    ChartColumn,
  } from '@lucide/svelte';
  import PdfThumbnail from '$lib/components/shared/PdfThumbnail.svelte';
  import { untrack, tick, onMount, onDestroy } from 'svelte';
  import { slide, fade, scale } from 'svelte/transition';
  import { getPreviewText, parseEnvelope } from '$lib/envelope';
  import VoiceRecorder from './VoiceRecorder.svelte';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import MentionComposerInput from '$lib/components/shared/MentionComposerInput.svelte';
  import MediaLightbox from '$lib/components/shared/MediaLightbox.svelte';
  import GifPickerModal from './GifPickerModal.svelte';
  import type { PendingMediaFile } from '$lib/media';
  import { mediaAspectStyle } from '$lib/utils/mediaLayout';
  import { isTauriRuntime } from '$lib/utils/openExternal';
  import { downloadDecryptedFile } from '$lib/utils/fileDownload';
  import { m } from '$lib/paraglide/messages';
  import { isNarrowChatLayout, NARROW_CHAT_QUERY, onViewportChange } from '$lib/utils/viewport';

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
    /** Optional callback emitting throttled typing start/stop signals. */
    onTyping?: (isTyping: boolean) => void;
    /** Optional callback to send a picked GIF (by direct URL). Enables the GIF button. */
    onSendGif?: (url: string) => void;
    /** Optional callback to open the poll composer. Enables the "Sondage" button (channels only). */
    onCreatePoll?: () => void;
    /** "X écrit…" label shown just above the input, or empty when nobody is typing. */
    typingLabel?: string;
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
    /** When set, only users whose IDs are in this list appear in @mention suggestions. */
    allowedUserIds?: string[];
  }

  let {
    messageText,
    onMessageChange,
    onSend,
    onFocusChange,
    onTyping,
    onSendGif,
    onCreatePoll,
    typingLabel,
    replyingTo,
    onCancelReply,
    onFilesSelected,
    pendingFiles = [],
    onRemovePendingFile,
    isUploading = false,
    allowedUserIds,
  }: Props = $props();

  /**
   * Height of exactly one empty composer line, DERIVED FROM THE SAME TOKENS AS THE PADDING rather
   * than typed as a number: the line box, plus `.chat-composer-textarea`'s 0.5rem of padding top and
   * bottom.
   *
   * IT IS A VARIABLE AND NOT A `calc`, BECAUSE THE ANSWER DIFFERS BY VIEWPORT AND AN INLINE STYLE
   * CANNOT. Measured 2026-09-09 at 390x844: the icon buttons are 44px on a phone (a touch target)
   * and 36px from 768px up, while the field was 36px everywhere - so with the row's `flex-end` the
   * text sat exactly 4px below the icons' centre line ON A PHONE ONLY, which is the vertical
   * centring the user has now reported twice. `--composer-field-height` is declared beside the
   * padding that produces it, so the floor and the padding cannot disagree.
   *
   * The height comes from the PADDING, never from a floor above the natural height: the placeholder
   * is `absolute inset-0` and positions its text with the same padding, so a floor taller than the
   * content leaves the placeholder off the line the real text sits on. That was the previous defect
   * here and it is the reason this is not simply `min-height: 2.75rem`.
   */
  const COMPOSER_MIN_HEIGHT = 'var(--composer-field-height)';
  /** Ceiling before the field scrolls instead of growing. Mirrors `.chat-composer-textarea`'s `max-height: 10rem`. */
  const COMPOSER_MAX_HEIGHT_PX = 160;

  let mentionComposer = $state<MentionComposerInput | null>(null);
  let composerFooter = $state<HTMLElement | null>(null);
  let fileInput: HTMLInputElement | undefined = $state();
  let isDragOver = $state(false);
  let showGifPicker = $state(false);
  /** GIF button is only shown when a KLIPY key is configured (Tenor closed; Giphy free tier too small). */
  const hasGifPicker = !!(import.meta.env as Record<string, string | undefined>).VITE_KLIPY_KEY;
  let previewUrls = $state<Record<string, string>>({});
  /** Index into imageEntries of the currently open lightbox, or null when closed. */
  let lightboxIndex = $state<number | null>(null);

  /** Ordered list of pending image entries that have a preview URL, for lightbox navigation. */
  const imageEntries = $derived(
    pendingFiles
      .map((entry, index) => ({ entry, index, key: fileKey(entry.file, index) }))
      .filter(({ entry, key }) => isImageFile(entry.file) && !!previewUrls[key])
  );

  function openLightbox(key: string) {
    const idx = imageEntries.findIndex((e) => e.key === key);
    if (idx !== -1) lightboxIndex = idx;
  }

  function downloadLightboxImage() {
    if (lightboxIndex === null) return;
    const entry = imageEntries[lightboxIndex];
    if (!entry) return;
    const url = previewUrls[entry.key];
    if (!url) return;
    void downloadDecryptedFile(url, entry.entry.file.name);
  }
  const hasMediaRecorder =
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;
  let isMobileViewport = $state(false);
  /** True as soon as the user has typed something: used to free up composer width. */
  const isComposing = $derived(messageText.trim().length > 0);

  /**
   * The user asked for the controls back WHILE a message is being written.
   *
   * Kept separate from `isComposing` rather than folded into it, because the two answer different
   * questions - "is there text" and "did someone ask to see the buttons".
   *
   * **THE REQUEST LASTS UNTIL THE NEXT KEYSTROKE, NOT UNTIL THE MESSAGE IS SENT** (user,
   * 2026-09-09: *"Taper sur le clavier doit TOUJOURS replier joindre, GIF, micro, pas juste au
   * premier caractere"*). The first draft held it for the whole message, on the reasoning that
   * forgetting it per keystroke would lose an explicit request. On a phone that reasoning is
   * backwards: the group is 4 x 52px of a ~358px row, so once it is open the field is back to a
   * third of the bar and stays there for every character after it - which is the crowding the fold
   * exists to remove, restored permanently by one tap. Reaching a button is two taps either way
   * (chevron, then button) and neither involves typing, so clearing the flag on text costs the
   * user nothing and keeps the room.
   */
  let controlsForcedOpen = $state(false);

  /**
   * THE EDGE CONTROLS FOLD AWAY ONCE TYPING STARTS (user, 2026-09-08, citing the reference:
   * *"les icones sur les bords disparaissent quand tu commences a taper pour laisser toute la
   * place"*).
   *
   * Three of the four already did this and the paperclip did not, which is the shape that reads as
   * an oversight rather than a rule. In a community channel the group is paperclip + poll + GIF +
   * voice - 4 x 52px of a ~358px row on a phone - so folding it is most of the width back.
   *
   * It is a FOLD and not a removal: a chevron takes the group's place, and pressing it brings every
   * button back for as long as this message lasts. Hiding a control with no way to reach it would
   * mean clearing a half-written message to attach a file.
   */
  const controlsCollapsed = $derived(isComposing && !controlsForcedOpen);

  /**
   * The other way the request ends: the message goes away without a text CHANGE event.
   *
   * Still load-bearing beside the reset in `handleMessageChange`. The chevron only exists while
   * there is text, so a forced-open flag can outlive its message exactly once - press chevron,
   * attach a file (no keystroke), send - and the parent clears `messageText` as a prop rather than
   * through the editor's `onchange`.
   */
  $effect(() => {
    if (!isComposing && controlsForcedOpen) controlsForcedOpen = false;
  });

  /**
   * A RECORDING TAKES THE WHOLE ROW, so the row has to know one is happening.
   *
   * The user asked for the reference's shape (2026-09-09): *"ca couvre toute la barre de saisie en
   * faisant disparaitre le reste"*. This is that, done by not rendering the other children rather
   * than by covering them - an overlay would have been a stacking context to get wrong, and the
   * user has an open complaint about panels ending up under banners.
   */
  let isVoiceActive = $state(false);

  const isVoiceRecordingSupported = $derived(
    // Show on mobile/coarse-pointer devices AND on Tauri desktop where MediaRecorder is available.
    // Hidden on regular desktop Web browsers to keep the composer uncluttered.
    // Also hidden once the user starts typing so the text area gets the extra width
    // (fewer line wraps → the field grows vertically far less aggressively).
    hasMediaRecorder && (isMobileViewport || isTauriRuntime()) && !controlsCollapsed
  );

  const isSendDisabled = $derived(
    (!messageText.trim() && pendingFiles.length === 0) || isUploading
  );

  // ── Typing signal (throttled) ──────────────────────────────────────────────
  // Emit `start` at most once per 3s while typing, and `stop` after 4s of
  // inactivity (or on send/blur/unmount), so the gateway broadcast stays cheap.
  let typingActive = false;
  let lastTypingSentAt = 0;
  let typingIdleTimer: ReturnType<typeof setTimeout> | null = null;

  function stopTyping() {
    if (typingIdleTimer) {
      clearTimeout(typingIdleTimer);
      typingIdleTimer = null;
    }
    if (typingActive) {
      typingActive = false;
      onTyping?.(false);
    }
  }

  function pingTyping() {
    const now = Date.now();
    if (!typingActive || now - lastTypingSentAt > 3000) {
      typingActive = true;
      lastTypingSentAt = now;
      onTyping?.(true);
    }
    if (typingIdleTimer) clearTimeout(typingIdleTimer);
    typingIdleTimer = setTimeout(stopTyping, 4000);
  }

  function handleMessageChange(value: string) {
    onMessageChange(value);
    // Typing re-folds the edge controls, every time - see `controlsForcedOpen`. This is the single
    // funnel for a text change (`MentionComposerInput` fires it only when the text really moved,
    // and never mid-IME-composition), so it is the one place the rule has to hold.
    controlsForcedOpen = false;
    if (value.trim().length > 0) pingTyping();
    else stopTyping();
  }

  onDestroy(stopTyping);

  function toReplyPreview(value: string): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= 96) return normalized;
    return `${normalized.slice(0, 93)}…`;
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
        stopTyping();
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
      /*
       * THE COLLAPSED HEIGHT BELONGS TO THE CSS, NOT TO THIS EFFECT. Clearing the inline height
       * first lets `min-height` decide what one empty line is, and the grown height is only written
       * when the content genuinely needs more than that.
       *
       * It used to write a literal `44px` as both the reset and the floor. That number was the
       * field's height under its ORIGINAL padding, and an inline style beats every stylesheet - so
       * when the padding moved to the measured 8px the box stayed pinned at 44 while `min-height`
       * computed a correct 36, and the placeholder (absolutely positioned, padded from the top) sat
       * 4px above the centre line. A hardcoded pixel height in script cannot be kept in agreement
       * with a token in CSS; not writing one is the only form that can.
       */
      el.style.height = '';
      const oneLine = el.getBoundingClientRect().height;
      const needed = Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX);
      if (needed > oneLine) el.style.height = `${needed}px`;
    });
  });

  $effect(() => {
    isMobileViewport = isNarrowChatLayout();
    return onViewportChange(NARROW_CHAT_QUERY, (narrow) => {
      isMobileViewport = narrow;
    });
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

<!--
  The icon-and-name tile shown for an attachment with no usable preview - a non-image, non-PDF file,
  or a PDF whose first page has not rendered (yet, or at all). Declared once and rendered from both
  branches: it is the PdfThumbnail fallback as well as the plain default, and the two drifting apart
  is exactly how one of them ends up looking like a different product.
-->
{#snippet filePlaceholder(name: string)}
  <div
    class="text-text-muted flex h-full w-full flex-col items-center justify-center gap-1.5 bg-black/5 px-2 dark:bg-white/5"
  >
    <FileText size={20} strokeWidth={1.5} />
    <span
      class="text-2xs sm:text-2xs line-clamp-2 px-1 text-center leading-tight font-medium break-all"
    >
      {name}
    </span>
  </div>
{/snippet}

<!-- Footer Container -->
<footer class="chat-composer-footer" bind:this={composerFooter}>
  <!--
    Typing indicator: sits just above the input field, never behind it.

    The live region is rendered UNCONDITIONALLY and only its contents change. A `role="status"`
    element created by an `{#if}` at the moment it gains text is announced unreliably - assistive
    technology has to be observing the region BEFORE the mutation - so the wrapper is permanent and
    the `{#if}` moved inside it. It is also the only stable hook the harness has on this indicator,
    whose text is otherwise localized prose.
  -->
  <div class="chat-typing-indicator" role="status" aria-live="polite">
    {#if typingLabel}
      <div transition:slide={{ duration: 150, axis: 'y' }} class="px-3 pb-1 sm:px-4 md:px-6">
        <span class="text-text-muted inline-flex items-center gap-1.5 text-xs font-medium">
          <span class="flex items-end gap-0.5" aria-hidden="true">
            <span class="h-1 w-1 animate-bounce rounded-full bg-current" style="animation-delay:0ms"
            ></span>
            <span
              class="h-1 w-1 animate-bounce rounded-full bg-current"
              style="animation-delay:150ms"
            ></span>
            <span
              class="h-1 w-1 animate-bounce rounded-full bg-current"
              style="animation-delay:300ms"
            ></span>
          </span>
          {typingLabel}
        </span>
      </div>
    {/if}
  </div>
  <!-- Reply preview strip. -->
  {#if replyingTo}
    <div transition:slide={{ duration: 200, axis: 'y' }} class="pointer-events-auto">
      <div
        class="bg-cn-surface relative mx-3 mb-3 flex items-center justify-between overflow-hidden rounded-2xl border border-black/5 p-3 shadow-lg sm:mx-4 md:mx-6 md:p-4 dark:border-white/10"
      >
        <div
          class="absolute top-0 bottom-0 left-0 w-1.5 bg-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.6)]"
        ></div>
        <div class="min-w-0 flex-1 pl-1.5">
          <div
            class="mb-0.5 flex items-center gap-1.5 text-xs font-bold text-amber-600 dark:text-amber-500"
          >
            <span class="truncate"
              >{m.chat_reply_to_message({
                replySenderDisplayName: replySenderDisplayName || m.user_unknown_label(),
              })}</span
            >
          </div>
          <div class="text-text-muted truncate text-xs leading-snug font-medium">
            {replyPreviewText}
          </div>
        </div>
        {#if onCancelReply}
          <button
            onclick={onCancelReply}
            class="text-text-muted hover:text-text-main ml-2 flex-shrink-0 rounded-full bg-black/5 p-2 transition-all outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 dark:bg-white/5 dark:hover:bg-white/10"
            aria-label={m.chat_cancel_reply_label()}
          >
            <X size={16} strokeWidth={2.5} />
          </button>
        {/if}
      </div>
    </div>
  {/if}

  <div class="pointer-events-auto flex flex-col gap-2 px-3 sm:px-4 md:px-6">
    <!-- Pending file attachments. -->
    {#if pendingFiles.length > 0}
      <div transition:slide={{ duration: 200, axis: 'y' }} class="w-full">
        <div class="text-text-muted text-2xs mb-2 px-1 font-bold tracking-wider uppercase">
          {m.chat_pending_files_count({ pendingFiles: pendingFiles.length })}
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
              class="group/file bg-cn-surface relative w-20 overflow-hidden rounded-[1rem] border border-black/5 shadow-md sm:w-24 dark:border-white/10"
              style="{thumbAspect}; max-height: 6rem;"
            >
              {#if isImageFile(file) && previewUrls[key]}
                <button
                  type="button"
                  class="block h-full w-full cursor-zoom-in border-0 p-0"
                  aria-label={m.chat_enlarge_preview_label()}
                  onclick={(e) => {
                    e.stopPropagation();
                    openLightbox(key);
                  }}
                  onpointerdown={(e) => e.stopPropagation()}
                >
                  <img src={previewUrls[key]} alt={file.name} class="h-full w-full object-cover" />
                </button>
              {:else if isPdfFile(file) && previewUrls[key]}
                <!--
                  RASTERISED BY pdf.js, never embedded. This was an `<embed type="application/pdf">`
                  handing the blob to the browser's native plugin, which the site's own CSP forbids
                  (`object-src 'none'`) - so it was blocked for every user, on every browser, and the
                  preview it was supposed to draw was an empty white box. It is the one place that
                  was never migrated to the canvas path every other PDF surface uses.
                -->
                <PdfThumbnail
                  url={previewUrls[key]}
                  maxWidth={160}
                  imgClass="w-full h-full object-cover object-top"
                >
                  {#snippet fallback()}
                    {@render filePlaceholder(file.name)}
                  {/snippet}
                </PdfThumbnail>
              {:else}
                {@render filePlaceholder(file.name)}
              {/if}

              <!-- Gradient overlay and file name. -->
              <div
                class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pt-4 pb-1.5"
              >
                <div
                  class="text-2xs sm:text-2xs truncate font-medium text-white drop-shadow-md"
                  title={file.name}
                >
                  {file.name}
                </div>
              </div>

              <!-- Remove button. -->
              {#if onRemovePendingFile}
                <button
                  type="button"
                  class="absolute top-1.5 right-1.5 inline-flex h-6 w-6 scale-90 items-center justify-center rounded-full bg-black/50 text-white opacity-100 shadow-sm transition-all duration-200 outline-none hover:scale-105 hover:bg-red-500 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-red-500 active:scale-95 sm:opacity-0 sm:group-hover/file:opacity-100"
                  onclick={() => onRemovePendingFile(index)}
                  aria-label={m.chat_remove_file_label()}
                  title={m.common_remove_label()}
                >
                  <X size={14} strokeWidth={2.5} />
                </button>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Main input bar. -->
    <div
      role="group"
      aria-label={m.chat_composer_group_label()}
      class="chat-composer-panel {isDragOver ? 'is-dragover' : ''}"
      ondragover={!isMobileViewport ? handleDragOver : undefined}
      ondragleave={!isMobileViewport ? handleDragLeave : undefined}
      ondrop={!isMobileViewport ? handleDrop : undefined}
    >
      <!-- Drag-and-drop badge overlay. -->
      {#if isDragOver}
        <div
          transition:fade={{ duration: 150 }}
          class="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 -translate-y-16"
        >
          <span
            class="text-cn-ink flex items-center gap-2 rounded-full bg-amber-500 px-4 py-2.5 text-sm font-bold whitespace-nowrap shadow-xl shadow-amber-500/20"
          >
            <CloudUpload size={18} strokeWidth={2.5} />
            {m.chat_drag_files_badge()}
          </span>
        </div>
      {/if}

      <!-- The chevron that brings the folded group back. Takes the group's place, never adds to it. -->
      {#if controlsCollapsed && !isVoiceActive}
        <div class="shrink-0">
          <button
            type="button"
            onclick={() => (controlsForcedOpen = true)}
            title={m.chat_show_composer_actions_title()}
            aria-label={m.chat_show_composer_actions_title()}
            aria-expanded="false"
            class="chat-composer-icon-button chat-composer-chevron"
          >
            <ChevronRight size={20} strokeWidth={2.5} />
          </button>
        </div>
      {/if}

      <!-- Attachment button. -->
      {#if !controlsCollapsed && !isVoiceActive}
        <div class="shrink-0">
          <button
            onclick={() => fileInput?.click()}
            disabled={isUploading}
            title={m.chat_attach_file_title()}
            aria-label={m.chat_attach_file_label()}
            class="chat-composer-icon-button"
          >
            {#if isUploading}
              <LoaderCircle class="h-5 w-5 animate-spin text-amber-500" strokeWidth={2.5} />
            {:else}
              <Paperclip size={20} strokeWidth={2} />
            {/if}
          </button>
        </div>
      {/if}

      <!-- Poll button (communities only: parent provides onCreatePoll). -->
      {#if onCreatePoll && !controlsCollapsed && !isVoiceActive}
        <div class="shrink-0">
          <button
            type="button"
            onclick={() => onCreatePoll()}
            title={m.chat_create_poll_title()}
            aria-label={m.chat_create_poll_label()}
            class="chat-composer-icon-button"
          >
            <ChartColumn size={20} strokeWidth={2} />
          </button>
        </div>
      {/if}

      <!-- GIF button (shown when KLIPY is configured). -->
      {#if hasGifPicker && onSendGif && !controlsCollapsed && !isVoiceActive}
        <div class="shrink-0">
          <button
            type="button"
            onclick={() => (showGifPicker = true)}
            title={m.chat_send_gif_title()}
            aria-label={m.chat_send_gif_label()}
            class="chat-composer-icon-button text-2xs font-bold tracking-tight"
          >
            GIF
          </button>
        </div>
      {/if}

      <!-- Voice recorder (mobile and the desktop shell). Its own root owns its width, so there is
           no wrapper here: `shrink-0` while idle, `flex-1` once it has taken the row. The second
           half of the condition keeps it mounted through a recording that outlives the microphone
           button's own visibility rule. -->
      {#if isVoiceRecordingSupported || isVoiceActive}
        <VoiceRecorder
          onRecordingComplete={handleVoiceRecording}
          onActiveChange={(active) => (isVoiceActive = active)}
        />
      {/if}

      <input
        bind:this={fileInput}
        type="file"
        multiple
        accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.zip"
        class="hidden"
        onchange={handleFileChange}
      />

      <!-- Auto-expanding text field. Absent during a recording: see `isVoiceActive`. -->
      {#if !isVoiceActive}
        <MentionComposerInput
          bind:this={mentionComposer}
          value={messageText}
          {allowedUserIds}
          onchange={handleMessageChange}
          class="min-w-0 flex-1"
          editorClass="chat-composer-textarea"
          placeholder={m.chat_message_placeholder()}
          minHeight={COMPOSER_MIN_HEIGHT}
          onfocus={() => onFocusChange?.(true)}
          onblur={() => {
            onFocusChange?.(false);
            stopTyping();
          }}
          onkeydown={handleComposerKeydown}
          onpaste={handlePaste}
        />

        <!-- Dynamic send button. -->
        <div class="shrink-0 pr-1">
          <button
            onmousedown={(e) => e.preventDefault()}
            onclick={() => {
              mentionComposer?.commitComposition();
              onSend();
              stopTyping();
              mentionComposer?.clearEditor();
            }}
            disabled={isSendDisabled}
            aria-label={m.chat_send_message_label()}
            class="chat-composer-send-button {isSendDisabled ? 'is-disabled' : ''}"
          >
            <!-- Slight icon offset for optical centering. -->
            <Send size={18} strokeWidth={2.5} class={isSendDisabled ? '' : 'mt-0.5 ml-0.5'} />
          </button>
        </div>
      {/if}
    </div>
  </div>
</footer>

{#if lightboxIndex !== null && imageEntries[lightboxIndex]}
  {@const currentEntry = imageEntries[lightboxIndex]}
  <MediaLightbox
    open={true}
    onClose={() => (lightboxIndex = null)}
    title={currentEntry.entry.file.name}
    onDownload={downloadLightboxImage}
    showPrev={lightboxIndex > 0}
    showNext={lightboxIndex < imageEntries.length - 1}
    onPrev={() => (lightboxIndex = (lightboxIndex ?? 1) - 1)}
    onNext={() => (lightboxIndex = (lightboxIndex ?? 0) + 1)}
    dotCount={imageEntries.length > 1 ? imageEntries.length : 0}
    dotIndex={lightboxIndex}
    onDotSelect={(i) => (lightboxIndex = i)}
  >
    <img
      src={previewUrls[currentEntry.key]}
      alt={currentEntry.entry.file.name}
      class="max-h-full max-w-full object-contain select-none"
    />
  </MediaLightbox>
{/if}

{#if onSendGif}
  <GifPickerModal
    open={showGifPicker}
    onClose={() => (showGifPicker = false)}
    onSelect={(url) => onSendGif?.(url)}
  />
{/if}
