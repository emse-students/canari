<script lang="ts">
  import { ChevronDown, CornerDownRight, ImageIcon, Send, X } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import { getToken } from '$lib/stores/auth';
  import GifPickerModal from '$lib/components/chat/GifPickerModal.svelte';
  import MentionComposerInput from '$lib/components/shared/MentionComposerInput.svelte';
  import Picker from '$lib/components/ui/Picker.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import AnonymousAvatar from '$lib/components/shared/AnonymousAvatar.svelte';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import { fetchGifFile, GifRelayError, proxiedGifUrl } from '$lib/utils/gifMediaProxy';
  import {
    commentGifRendition,
    pickGridRendition,
    type GifResult,
  } from '$lib/utils/chat/gifSearch';
  import { MediaService, compressImage, IMAGE_COMPRESS_PRESETS } from '$lib/media';
  import { mediaAspectStyle } from '$lib/utils/mediaLayout';
  import { isCoarsePointerDevice } from '$lib/utils/pointerDevice';
  import { COMMENT_MAX_LENGTH, type PostMediaRef } from '$lib/posts/api';
  import { ANONYMOUS_POST_IDENTITY } from '$lib/posts/postComposerDraft';
  import {
    clearPostCommentDraft,
    loadPostCommentDraft,
    savePostCommentDraft,
  } from '$lib/posts/postCommentDraft';
  import {
    commentIdentityOf,
    listPostAsAssociations,
    type CommentIdentity,
  } from '$lib/posts/postIdentity';
  import type { CommentOutcome } from '$lib/posts/postCommentThread.svelte';
  import { associationPickerOptions } from '$lib/associations/selectGroups';
  import type { Association } from '$lib/associations/api';
  import { getSavedDisplayName } from '$lib/stores/user';
  import { showToast } from '$lib/stores/toast.svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE BOX A COMMENT IS WRITTEN IN, and everything that belongs to writing one: the reply banner,
   * the identity (the member, anonymous, or an association they may speak for), one attached image
   * or GIF, the draft kept per account and per post, and the error of a failed send said HERE, next
   * to the box - it used to be a banner at the bottom of the whole card, off screen in a long thread.
   *
   * The text is the host's (`value` / `onChange`, as before); the host also owns the REPLY target and
   * the send itself (`onSubmit`), because both are the thread's. This component never reads a comment.
   */
  interface Props {
    postId: string;
    /** The text, controlled by the host. */
    value: string;
    onChange: (text: string) => void | Promise<void>;
    placeholder: string;
    /** A comment is on its way: the send button waits. */
    submitting: boolean;
    currentUserId: string;
    /** The comment being answered, if any. */
    replyTo: { id: string; name: string } | null;
    onCancelReply: () => void;
    /** A kept draft named a comment it was answering: the host re-enters reply mode on it. */
    onRestoreReply?: (commentId: string) => void;
    /** Sends. The identity is returned to the host with the media; its outcome decides what resets. */
    onSubmit: (send: {
      parentId?: string;
      media?: PostMediaRef;
      identity: CommentIdentity;
    }) => Promise<CommentOutcome>;
    /** Why the last send did not go, in the reader's words; shown until they type again. */
    sendError?: string;
    /** Optional external keydown handler, called after the internal shortcuts. */
    onKeyDown?: (e: KeyboardEvent) => void;
  }

  let {
    postId,
    value,
    onChange,
    placeholder,
    submitting,
    currentUserId,
    replyTo,
    onCancelReply,
    onRestoreReply,
    onSubmit,
    sendError = '',
    onKeyDown,
  }: Props = $props();

  let inputRef = $state<{ focusEditor: () => void } | null>(null);

  /** Puts the caret in the box - on a tap on "Répondre", which used to leave the reader to find it. */
  export function focus(): void {
    inputRef?.focusEditor();
  }

  // --- Attached media --------------------------------------------------------------------------
  const mediaService = new MediaService();
  let pendingMedia = $state<PostMediaRef | null>(null);
  let pendingPreviewUrl = $state<string | null>(null);
  let uploadingMedia = $state(false);
  let showGifPicker = $state(false);
  /** True while the box is focused, so only the focused one handles a keyboard GIF. */
  let inputFocused = $state(false);

  function clearPendingMedia() {
    if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    pendingMedia = null;
    pendingPreviewUrl = null;
  }

  /**
   * Encrypts and uploads an image/GIF, then stages it as the pending media (preview + ref). GIFs go
   * up as-is: canvas compression would keep one frame and drop the animation. Shared by paste, the
   * in-app GIF picker and keyboard-committed GIFs.
   */
  async function stageMediaFile(file: File) {
    uploadingMedia = true;
    try {
      let uploadFile = file;
      let dims: { width: number; height: number } | undefined;
      if (file.type.startsWith('image/') && file.type !== 'image/gif') {
        const { maxWidth, maxHeight, quality } = IMAGE_COMPRESS_PRESETS.comment;
        const compressed = await compressImage(file, maxWidth, maxHeight, quality);
        uploadFile = compressed.file;
        dims = { width: compressed.width, height: compressed.height };
      }
      // Read at upload time: a token held since the card was drawn expires after 15 min.
      const ref = await mediaService.encryptAndUpload(
        uploadFile,
        await getToken(),
        dims,
        'archive'
      );
      const { type: _type, ...mediaFields } = ref;
      clearPendingMedia();
      pendingMedia = mediaFields as PostMediaRef;
      pendingPreviewUrl = URL.createObjectURL(uploadFile);
    } catch (err) {
      console.error('Failed to upload comment media', err);
      showToast(m.post_comment_media_error());
    } finally {
      uploadingMedia = false;
    }
  }

  async function handlePaste(e: ClipboardEvent) {
    const fileItem = Array.from(e.clipboardData?.items ?? []).find((item) => item.kind === 'file');
    if (!fileItem) return;
    e.preventDefault();
    const file = fileItem.getAsFile();
    if (file) await stageMediaFile(file);
  }

  /**
   * A picked GIF on its way: shown AT ONCE as the attachment chip with a progress bar, and, when it
   * does not arrive, with the cause and a retry - the reader never faces a closed picker, a silent
   * wait and a toast that vanished.
   */
  let gifLoad = $state<{
    gif: GifResult;
    progress: number;
    error: string;
  } | null>(null);
  let gifAbort: AbortController | null = null;

  /** The sentence for a failed GIF download, by the cause the relay client classified. */
  function gifFailureMessage(error: unknown): string {
    if (error instanceof GifRelayError) {
      if (error.failure === 'busy') return m.post_comment_gif_busy();
      if (error.failure === 'timeout') return m.post_comment_gif_timeout();
      if (error.failure === 'too-large') return m.post_comment_gif_too_large();
    }
    return m.post_comment_gif_fetch_error();
  }

  /**
   * In-app GIF picker: fetches the chosen GIF's bytes (the SMALL rendition, which is plenty at a
   * comment's width) and stages them as encrypted media. The bytes come through Canari's GIF relay
   * (`fetchGifFile`), never from KLIPY's CDN, so KLIPY does not see the person attaching it.
   */
  async function handleGifSelected(gif: GifResult) {
    showGifPicker = false;
    gifAbort?.abort();
    const controller = new AbortController();
    gifAbort = controller;
    gifLoad = { gif, progress: 0, error: '' };
    try {
      const file = await fetchGifFile(commentGifRendition(gif).url, {
        signal: controller.signal,
        onProgress: (fraction) => {
          if (gifAbort === controller && gifLoad) gifLoad = { ...gifLoad, progress: fraction };
        },
      });
      if (gifAbort !== controller) return;
      gifLoad = null;
      await stageMediaFile(file);
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error('Failed to load GIF', err);
      gifLoad = { gif, progress: 0, error: gifFailureMessage(err) };
    } finally {
      if (gifAbort === controller) gifAbort = null;
    }
  }

  /** Drops the GIF being fetched (or the failed one): no request keeps running behind the chip. */
  function dismissGifLoad() {
    gifAbort?.abort();
    gifAbort = null;
    gifLoad = null;
  }

  /** Rebuilds a File from a keyboard-committed GIF (base64, Android/iOS) and stages it. */
  function handleKeyboardMedia(detail: { mime?: string; name?: string; data?: string }) {
    if (!inputFocused || !detail?.data) return;
    try {
      const bin = atob(detail.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const mime = detail.mime || 'image/gif';
      const name = detail.name || `gif-${Date.now()}.${mime.split('/')[1] ?? 'gif'}`;
      void stageMediaFile(new File([bytes], name, { type: mime }));
    } catch (err) {
      console.error('Failed to handle keyboard GIF', err);
      showToast(m.post_comment_media_error());
    }
  }

  // --- Draft: per account and per post -----------------------------------------------------------
  let draftReady = $state(false);

  onMount(() => {
    const draft = loadPostCommentDraft(postId);
    if (draft && !value) {
      Log.d(`[CommentComposer] draft restored on ${postId.slice(0, 8)}`);
      void onChange(draft.text);
      if (draft.parentId) onRestoreReply?.(draft.parentId);
    }
    draftReady = true;

    const onKeyboardMedia = (e: Event) => handleKeyboardMedia((e as CustomEvent).detail ?? {});
    window.addEventListener('canari-keyboard-media', onKeyboardMedia);
    return () => {
      window.removeEventListener('canari-keyboard-media', onKeyboardMedia);
      gifAbort?.abort();
    };
  });

  /** Every change is kept; an empty box forgets the draft (the module clears on empty text). */
  $effect(() => {
    const text = value;
    const parentId = replyTo?.id ?? null;
    if (!draftReady) return;
    if (text.trim() === '') clearPostCommentDraft(postId);
    else savePostCommentDraft(postId, { text, parentId });
  });

  // --- Identity -----------------------------------------------------------------------------------
  /** `''` (the member), `ANONYMOUS_POST_IDENTITY`, or an association id - the post composer's own field. */
  let identityValue = $state('');
  let associations = $state<Association[]>([]);
  let associationsAsked = false;

  /**
   * Asks which associations the member may speak for, ONCE, when the box is first used: not on
   * mount, because every card with a comment draws this composer and a global admin's list is every
   * association. A failure is logged and leaves the two choices that need no list.
   */
  async function ensureAssociations() {
    if (associationsAsked) return;
    associationsAsked = true;
    try {
      associations = await listPostAsAssociations();
    } catch (err) {
      Log.d('CommentComposer', `could not list the associations to comment as: ${String(err)}`);
    }
  }

  const personalLabel = getSavedDisplayName() || m.post_create_personal_profile_label();
  const identityOptions = $derived<PickerOption[]>([
    { value: '', label: personalLabel },
    { value: ANONYMOUS_POST_IDENTITY, label: m.post_create_anonymous_label() },
    ...associationPickerOptions(associations),
  ]);
  const chosenAssociation = $derived(
    identityValue && identityValue !== ANONYMOUS_POST_IDENTITY
      ? associations.find((a) => a.id === identityValue)
      : undefined
  );

  // --- Sending ------------------------------------------------------------------------------------
  const canSend = $derived(
    (value.trim() !== '' || pendingMedia !== null) &&
      !submitting &&
      !uploadingMedia &&
      // A GIF still arriving would be left behind by a send: wait for it, or dismiss it.
      !(gifLoad && !gifLoad.error)
  );
  const nearLimit = $derived(value.length >= COMMENT_MAX_LENGTH - 200);

  async function submit() {
    if (!canSend) return;
    const identity = commentIdentityOf(identityValue, associations);
    if (!identity) {
      // The chosen association is not in the list this device holds: sending would sign the
      // comment with the member's own name. Said, never sent.
      Log.d('CommentComposer', `identity ${identityValue.slice(0, 8)} is not offered - not sent`);
      showToast(m.post_comment_identity_unavailable());
      return;
    }
    const used = identityValue;
    const media = pendingMedia ?? undefined;
    clearPendingMedia();
    const outcome = await onSubmit({ parentId: replyTo?.id, media, identity });
    // Back to the member's own name after a SENT comment - an anonymous or association identity
    // must not stick to the next one by accident. A failed send KEEPS it: the retry goes out as the
    // writer chose, never silently under their own name.
    if (outcome === 'sent' && identityValue === used) identityValue = '';
  }

  function handleKeyDown(e: KeyboardEvent) {
    // A touch keyboard's Enter is a new line (the button sends); a physical keyboard's Enter sends.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isCoarsePointerDevice()) {
      e.preventDefault();
      void submit();
    }
    if (e.key === 'Escape' && replyTo) onCancelReply();
    onKeyDown?.(e);
  }
</script>

<div class="flex flex-col gap-2">
  {#if replyTo}
    <div
      class="animate-in fade-in slide-in-from-bottom-1 text-2xs ml-10 flex items-center justify-between rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-1.5 font-bold text-amber-700 dark:text-amber-400"
    >
      <span class="flex items-center gap-1.5"
        ><CornerDownRight size={14} />
        {m.post_replying_to_label({ name: replyTo.name })}</span
      >
      <button
        type="button"
        onclick={onCancelReply}
        class="ui-icon-button rounded-full transition-colors outline-none hover:bg-amber-500/20"
        aria-label={m.post_cancel_reply_label()}
      >
        <X size={14} strokeWidth={2.5} />
      </button>
    </div>
  {/if}

  {#if identityValue === ANONYMOUS_POST_IDENTITY}
    <p class="text-text-muted text-2xs ml-10">{m.post_comment_anonymous_hint()}</p>
  {:else if chosenAssociation}
    <p class="text-text-muted text-2xs ml-10">
      {m.post_comment_as_association_caption({ name: chosenAssociation.name })}
    </p>
  {/if}

  <div class="relative">
    {#if gifLoad}
      <div class="mb-2 ml-10 flex items-center gap-2" data-testid="comment-gif-load">
        <div
          class="relative max-h-14 w-20 shrink-0 overflow-hidden rounded-lg bg-black/10 dark:bg-white/10"
          style={mediaAspectStyle(gifLoad.gif.preview.width, gifLoad.gif.preview.height)}
        >
          <!-- The thumbnail the grid already drew: in the browser's cache, so it is there at once. -->
          <img
            src={proxiedGifUrl(pickGridRendition(gifLoad.gif, 80).url)}
            alt=""
            class="h-full w-full object-cover {gifLoad.error ? 'opacity-40' : ''}"
          />
          {#if !gifLoad.error}
            <div class="absolute inset-x-0 bottom-0 h-1 bg-black/20">
              <div
                class="h-full bg-amber-500 transition-[width]"
                style="width: {Math.round(gifLoad.progress * 100)}%"
                data-testid="comment-gif-progress"
              ></div>
            </div>
          {/if}
          <button
            type="button"
            onclick={dismissGifLoad}
            class="tap-target absolute top-0.5 right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-red-500"
            aria-label={m.post_remove_image_label()}
          >
            <X size={10} strokeWidth={3} />
          </button>
        </div>
        {#if gifLoad.error}
          <span class="text-2xs text-red-500" role="alert">{gifLoad.error}</span>
          <button
            type="button"
            onclick={() => gifLoad && void handleGifSelected(gifLoad.gif)}
            class="text-2xs font-semibold text-amber-600 underline dark:text-amber-400"
            data-testid="comment-gif-retry"
          >
            {m.chat_gif_retry()}
          </button>
        {:else}
          <span class="text-text-muted text-2xs animate-pulse">{m.common_loading_label()}</span>
        {/if}
      </div>
    {:else if pendingPreviewUrl || uploadingMedia}
      <div class="mb-2 ml-10 flex items-center gap-2">
        <div
          class="relative max-h-14 w-20 shrink-0 overflow-hidden rounded-lg bg-black/10 dark:bg-white/10"
          style={pendingMedia?.width && pendingMedia?.height
            ? mediaAspectStyle(pendingMedia.width, pendingMedia.height)
            : 'aspect-ratio: 10/7'}
        >
          {#if pendingPreviewUrl}
            <img src={pendingPreviewUrl} alt="GIF" class="h-full w-full object-cover" />
          {:else}
            <div class="flex h-full w-full items-center justify-center">
              <ImageIcon size={20} class="animate-pulse opacity-30" />
            </div>
          {/if}
          {#if !uploadingMedia}
            <button
              type="button"
              onclick={clearPendingMedia}
              class="tap-target absolute top-0.5 right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-red-500"
              aria-label={m.post_remove_image_label()}
            >
              <X size={10} strokeWidth={3} />
            </button>
          {/if}
        </div>
        {#if uploadingMedia}
          <span class="text-text-muted text-2xs animate-pulse">{m.common_loading_label()}</span>
        {/if}
      </div>
    {/if}

    <div class="flex items-end gap-2.5">
      <!-- The avatar is the identity: tapping it picks who this comment is written as. -->
      <!-- The list of associations is asked when the picker is reached (focus or press), once. -->
      <div
        role="presentation"
        class="shrink-0 pb-2 [@media(min-width:768px)_and_(pointer:fine)]:pb-1.25"
        onfocusin={() => void ensureAssociations()}
        onpointerdown={() => void ensureAssociations()}
      >
        <Picker
          id={`composer-identity-${postId}`}
          value={identityValue}
          options={identityOptions}
          onValueChange={(v) => (identityValue = v)}
          label={m.post_comment_identity_label()}
          triggerClass="tap-target block h-8 w-8 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          {#snippet trigger()}
            <span class="relative block h-8 w-8">
              <!-- The small chevron says the avatar is a choice: it picks who this is written as. -->
              <span
                aria-hidden="true"
                class="text-text-muted absolute -right-1 -bottom-1 z-10 flex h-4 w-4 items-center justify-center rounded-full border border-black/10 bg-white shadow-sm dark:border-white/20 dark:bg-neutral-800"
              >
                <ChevronDown size={10} strokeWidth={3} />
              </span>
              {#if identityValue === ANONYMOUS_POST_IDENTITY}
                <AnonymousAvatar fill />
              {:else if chosenAssociation}
                <AssociationAvatar
                  fill
                  shape="circle"
                  name={chosenAssociation.name}
                  logoUrl={chosenAssociation.logoUrl}
                />
              {:else}
                <Avatar userId={currentUserId} fill />
              {/if}
            </span>
          {/snippet}
          {#snippet leading(option)}
            <span class="block h-9 w-9">
              {#if option.value === ANONYMOUS_POST_IDENTITY}
                <AnonymousAvatar fill />
              {:else if option.value === ''}
                <Avatar fill userId={currentUserId} fallbackLabel={personalLabel} />
              {:else}
                {@const asso = associations.find((a) => a.id === option.value)}
                <AssociationAvatar
                  fill
                  shape="circle"
                  name={asso?.name ?? option.label}
                  logoUrl={asso?.logoUrl}
                />
              {/if}
            </span>
          {/snippet}
        </Picker>
      </div>

      <div
        class="flex min-w-0 flex-1 items-end rounded-3xl bg-black/5 py-0.5 pr-0.5 pl-3.5 transition-all focus-within:bg-white focus-within:ring-2 focus-within:ring-amber-500/50 dark:bg-white/10 dark:focus-within:bg-black/40"
        onfocusin={() => {
          inputFocused = true;
          void ensureAssociations();
        }}
        onfocusout={() => (inputFocused = false)}
      >
        <!-- Several lines now (it was `singleLine`), growing to about five and scrolling after: a
             long comment could not be read back or edited in one line. The send button and GIF sit
             at the bottom of the box, where a growing composer keeps them under the thumb. -->
        <MentionComposerInput
          bind:this={inputRef}
          {value}
          onchange={(text) => onChange(text)}
          {placeholder}
          maxlength={COMMENT_MAX_LENGTH}
          class="min-w-0 flex-1"
          editorClass="flex-1 bg-transparent text-sm font-medium text-text-main outline-none py-3 [@media(min-width:768px)_and_(pointer:fine)]:py-2.25 min-h-0 max-h-32 overflow-y-auto"
          minHeight="0"
          onpaste={handlePaste}
          onkeydown={handleKeyDown}
        />
        <button
          type="button"
          onclick={() => (showGifPicker = true)}
          disabled={uploadingMedia || (gifLoad !== null && !gifLoad.error)}
          title={m.chat_send_gif_label()}
          aria-label={m.chat_send_gif_label()}
          class="text-text-muted text-2xs tap-target mr-0.5 flex h-11 shrink-0 items-center px-1.5 font-bold tracking-tight transition-colors hover:text-amber-500 disabled:opacity-40 [@media(min-width:768px)_and_(pointer:fine)]:h-9.5"
        >
          GIF
        </button>
        <button
          type="button"
          onclick={submit}
          disabled={!canSend}
          class="ui-icon-button ml-1 rounded-full text-amber-500 transition-all outline-none hover:bg-amber-500/10 hover:text-amber-600 focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 disabled:opacity-40 disabled:hover:bg-transparent"
          aria-label={m.post_send_comment_label()}
        >
          <Send size={18} strokeWidth={2.5} class="ml-0.5" />
        </button>
      </div>
    </div>

    {#if nearLimit}
      <p class="text-text-muted text-2xs mt-1 text-right tabular-nums">
        {m.post_comment_length_counter({ count: value.length, max: COMMENT_MAX_LENGTH })}
      </p>
    {/if}
    {#if sendError}
      <p role="alert" class="text-red-err text-2xs mt-1.5 ml-10 font-semibold">{sendError}</p>
    {/if}
  </div>
</div>

<GifPickerModal
  open={showGifPicker}
  onClose={() => (showGifPicker = false)}
  onSelect={(gif) => handleGifSelected(gif)}
/>
