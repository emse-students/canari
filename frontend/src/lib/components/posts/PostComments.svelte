<script lang="ts">
  import {
    ChevronDown,
    ChevronUp,
    Send,
    X,
    CornerDownRight,
    Pencil,
    Trash2,
    ArrowUpDown,
    ImageIcon,
    Flag,
  } from '@lucide/svelte';
  import { tick } from 'svelte';
  import type { PostComment, PostImageRef } from '$lib/posts/api';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import PostImage from './PostImage.svelte';
  import { MediaService, compressImage, IMAGE_COMPRESS_PRESETS } from '$lib/media';
  import { mediaAspectStyle } from '$lib/utils/mediaLayout';
  import { timeAgo, exactDate } from '$lib/utils/time';
  import SvelteMarkdown from '@humanspeak/svelte-markdown';
  import PostMentionLink from './PostMentionLink.svelte';
  import PostCodeBlock from './PostCodeBlock.svelte';
  import PostCodespan from './PostCodespan.svelte';
  import { preprocessPostMarkdown } from '$lib/utils/posts/postMarkdown';
  import MentionComposerInput from '$lib/components/shared/MentionComposerInput.svelte';

  const mentionRenderers = {
    link: PostMentionLink,
    code: PostCodeBlock,
    codespan: PostCodespan,
  };

  type SortMode = 'recent' | 'oldest' | 'liked';

  /** Props for the PostComments section of a post card. */
  interface Props {
    /** All comments on the post (including replies). */
    comments: PostComment[];
    /** Top-level comments only (parentId is null). Pre-computed by the parent to avoid redundant filtering. */
    topLevelComments: PostComment[];
    /** Whether the full comment list is expanded (false = show preview only). */
    showComments: boolean;
    /** Current value of the comment input box, controlled by the parent. */
    commentText: string;
    /** True while a new comment is being submitted to prevent double-posting. */
    submittingComment: boolean;
    /** Authenticated user's ID, used to gate edit/delete controls. */
    currentUserId: string;
    /** Total comment count from the server (may be higher than comments.length if the list was truncated). */
    totalCommentCount?: number;
    /** Called when the user clicks "Afficher" / "Masquer" to toggle comment visibility. */
    onToggleComments: () => void;
    /** Called on each keystroke to sync the comment input value to the parent's state. */
    onCommentTextChange: (text: string) => Promise<void>;
    /** Called when the user submits a comment (or reply if parentId is provided). media is an optional encrypted GIF/image. */
    onAddComment: (parentId?: string, media?: PostImageRef) => Promise<void>;
    /** Called when the user toggles a like on a comment. */
    onLikeComment: (commentId: string) => void;
    /** Called when the user saves an inline edit. */
    onEditComment: (commentId: string, text: string) => Promise<void>;
    /** Called when the user deletes a comment. */
    onDeleteComment: (commentId: string) => Promise<void>;
    /** Called when the user reports a comment. */
    onReport?: (commentId: string) => void;
    /** Bearer token forwarded to PostImage for decrypting comment media. */
    authToken?: string;
    /** If provided, a "Load all comments" button is shown when totalCommentCount >= 20. */
    onLoadAllComments?: () => Promise<void>;
    /** Optional external keydown handler forwarded after internal shortcuts are processed. */
    onKeyDown?: (e: KeyboardEvent) => void;
  }

  let {
    comments,
    topLevelComments,
    showComments,
    commentText,
    submittingComment,
    currentUserId,
    authToken = '',
    totalCommentCount,
    onToggleComments,
    onCommentTextChange,
    onAddComment,
    onLikeComment,
    onEditComment,
    onDeleteComment,
    onReport,
    onLoadAllComments,
    onKeyDown,
  }: Props = $props();

  const mediaService = new MediaService();
  let pendingMedia = $state<PostImageRef | null>(null);
  let pendingPreviewUrl = $state<string | null>(null);
  let uploadingMedia = $state(false);

  function clearPendingMedia() {
    if (pendingPreviewUrl) {
      URL.revokeObjectURL(pendingPreviewUrl);
    }
    pendingMedia = null;
    pendingPreviewUrl = null;
  }

  async function handleCommentPaste(e: ClipboardEvent) {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItem = items.find((item) => item.kind === 'file' && item.type.startsWith('image/'));
    if (!imageItem) return;
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (!file || !authToken) return;
    uploadingMedia = true;
    try {
      const { maxWidth, maxHeight, quality } = IMAGE_COMPRESS_PRESETS.comment;
      const compressed = await compressImage(file, maxWidth, maxHeight, quality);
      const ref = await mediaService.encryptAndUpload(compressed.file, authToken, {
        width: compressed.width,
        height: compressed.height,
      });
      const { type: _type, ...mediaFields } = ref;
      pendingMedia = mediaFields as PostImageRef;
      pendingPreviewUrl = URL.createObjectURL(file);
    } catch (err) {
      console.error('Failed to upload comment media', err);
    } finally {
      uploadingMedia = false;
    }
  }

  let loadingAll = $state(false);

  /** Calls onLoadAllComments with a loading spinner, then clears the spinner. */
  async function handleLoadAll() {
    loadingAll = true;
    await onLoadAllComments?.();
    loadingAll = false;
  }

  let replyingToId = $state<string | null>(null);
  let replyingToName = $state<string>('');
  let editingCommentId = $state<string | null>(null);
  let editingText = $state('');
  let editInputEl = $state<HTMLInputElement | null>(null);
  let sortMode = $state<SortMode>('recent');

  $effect(() => {
    if (editingCommentId && editInputEl) {
      void tick().then(() => editInputEl?.focus());
    }
  });

  const PREVIEW_COUNT = 3;

  /** Enters reply mode, targeting the given comment, and cancels any active edit. */
  function initiateReply(comment: PostComment) {
    replyingToId = comment.id;
    replyingToName = getCommentAuthorName(comment);
    editingCommentId = null;
  }

  /** Exits reply mode and clears the reply target name. */
  function cancelReply() {
    replyingToId = null;
    replyingToName = '';
  }

  /** Enters inline edit mode for the given comment, pre-populating the edit input, and cancels any active reply. */
  function initiateEdit(comment: PostComment) {
    editingCommentId = comment.id;
    editingText = comment.text;
    replyingToId = null;
  }

  /** Exits inline edit mode and clears the edit buffer. */
  function cancelEdit() {
    editingCommentId = null;
    editingText = '';
  }

  /** Calls onEditComment with the trimmed edit text, then exits edit mode. */
  async function submitEdit() {
    if (!editingText.trim() || !editingCommentId) return;
    await onEditComment(editingCommentId, editingText.trim());
    cancelEdit();
  }

  /** Submits the comment (text and/or media) as a new comment or reply, then cancels reply mode. */
  async function handleSubmitComment() {
    if ((!commentText.trim() && !pendingMedia) || submittingComment || uploadingMedia) return;
    const media = pendingMedia ?? undefined;
    clearPendingMedia();
    await onAddComment(replyingToId ?? undefined, media);
    cancelReply();
  }

  function handleInternalKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmitComment();
    }
    if (e.key === 'Escape' && replyingToId) cancelReply();
    if (onKeyDown) onKeyDown(e);
  }

  /** Handles keyboard shortcuts on the inline comment edit input: Enter saves, Escape cancels. */
  function handleEditKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitEdit();
    }
    if (e.key === 'Escape') cancelEdit();
  }

  /** Returns the best available display name for a comment author: "firstName lastName" → displayName → userId as fallback. */
  function getCommentAuthorName(comment: PostComment): string {
    const first = comment.firstName?.trim();
    const last = comment.lastName?.trim();
    if (first && last) return `${first} ${last}`;
    if (first) return first;
    if (last) return last;
    if (comment.displayName?.trim()) return comment.displayName.trim();
    return comment.userId;
  }

  const sortedTopLevel = $derived.by(() => {
    const list = [...topLevelComments];
    if (sortMode === 'oldest')
      return list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    if (sortMode === 'liked')
      return list.sort((a, b) => (b.likes?.length ?? 0) - (a.likes?.length ?? 0));
    // recent = newest first
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  });

  const visibleComments = $derived(
    showComments ? sortedTopLevel : sortedTopLevel.slice(0, PREVIEW_COUNT)
  );
</script>

{#snippet commentNode(comment: PostComment, isReply: boolean)}
  {@const isOwn = comment.userId === currentUserId}
  {@const isEditing = editingCommentId === comment.id}
  <div class="flex items-start gap-2.5 {isReply ? 'mt-2.5' : 'mt-4'}">
    <a
      href="/profile/{encodeURIComponent(comment.userId)}"
      class="shrink-0 mt-0.5 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-full"
    >
      <Avatar userId={comment.userId} size="sm" />
    </a>

    <div class="flex-1 min-w-0">
      {#if isEditing}
        <!-- Mode édition inline -->
        <div
          class="flex items-center gap-2 bg-black/5 dark:bg-white/5 rounded-2xl rounded-tl-sm px-3.5 py-2.5 border border-amber-500/40"
        >
          <input
            type="text"
            bind:this={editInputEl}
            bind:value={editingText}
            onkeydown={handleEditKeyDown}
            class="flex-1 bg-transparent text-[0.9rem] font-medium text-text-main outline-none"
          />
          <button
            type="button"
            onclick={submitEdit}
            class="text-amber-500 hover:text-amber-400 shrink-0 outline-none"
            aria-label="Valider"
          >
            <Send size={15} strokeWidth={2.5} />
          </button>
          <button
            type="button"
            onclick={cancelEdit}
            class="text-text-muted hover:text-text-main shrink-0 outline-none"
            aria-label="Annuler"
          >
            <X size={15} strokeWidth={2.5} />
          </button>
        </div>
      {:else}
        <div
          class="bg-black/5 dark:bg-white/5 rounded-2xl rounded-tl-sm px-3.5 py-2.5 w-fit max-w-full border border-black/5 dark:border-white/5 shadow-sm"
        >
          <a
            href="/profile/{encodeURIComponent(comment.userId)}"
            class="font-bold text-[0.8rem] text-text-main hover:text-amber-500 transition-colors block mb-0.5 outline-none focus-visible:underline"
          >
            {getCommentAuthorName(comment)}
          </a>
          {#if isReply}
            <!-- Badge "En réponse à" sur les replies rendus -->
            {@const parentComment = comments.find((c) => c.id === comment.parentId)}
            {#if parentComment}
              <span
                class="flex items-center gap-1 text-[0.65rem] font-semibold text-text-muted mb-1 opacity-75"
              >
                <CornerDownRight size={11} />
                {getCommentAuthorName(parentComment)}
              </span>
            {/if}
          {/if}
          {#if comment.text}
            <div
              class="text-[0.9rem] text-text-main leading-snug break-words [&_p]:inline [&_p]:m-0"
            >
              <SvelteMarkdown
                source={preprocessPostMarkdown(comment.text)}
                renderers={mentionRenderers}
                options={{ gfm: true, breaks: true }}
              />
            </div>
          {/if}
          {#if comment.media && authToken}
            <div
              class="relative mt-1.5 w-full max-w-[14rem] rounded-xl overflow-hidden bg-black/5 dark:bg-white/5"
              style={mediaAspectStyle(comment.media.width, comment.media.height)}
            >
              <PostImage media={comment.media} {authToken} />
            </div>
          {/if}
        </div>
      {/if}

      <div class="flex items-center gap-3.5 px-2 mt-1">
        <span
          class="text-[0.65rem] font-bold text-text-muted opacity-80"
          title={exactDate(comment.createdAt)}>{timeAgo(comment.createdAt)}</span
        >

        <button
          type="button"
          onclick={() => onLikeComment(comment.id)}
          class="text-[0.7rem] font-extrabold transition-colors outline-none focus-visible:underline {comment.likes?.includes(
            currentUserId
          )
            ? 'text-red-500'
            : 'text-text-muted hover:text-text-main'}"
        >
          {comment.likes?.length ? `${comment.likes.length} J'aime` : "J'aime"}
        </button>

        {#if !isReply}
          <button
            type="button"
            onclick={() => initiateReply(comment)}
            class="text-[0.7rem] font-extrabold text-text-muted hover:text-text-main transition-colors outline-none focus-visible:underline"
          >
            Répondre
          </button>
        {/if}

        {#if isOwn && !isEditing}
          <button
            type="button"
            onclick={() => initiateEdit(comment)}
            class="text-[0.7rem] font-extrabold text-text-muted hover:text-amber-500 transition-colors outline-none"
            aria-label="Modifier"
          >
            <Pencil size={12} strokeWidth={2.5} />
          </button>
          <button
            type="button"
            onclick={() => onDeleteComment(comment.id)}
            class="text-[0.7rem] font-extrabold text-text-muted hover:text-red-500 transition-colors outline-none"
            aria-label="Supprimer"
          >
            <Trash2 size={12} strokeWidth={2.5} />
          </button>
        {:else if !isOwn && onReport}
          <button
            type="button"
            onclick={() => onReport?.(comment.id)}
            class="text-[0.7rem] font-extrabold text-text-muted hover:text-red-400 transition-colors outline-none"
            aria-label="Signaler ce commentaire"
            title="Signaler"
          >
            <Flag size={11} strokeWidth={2.5} />
          </button>
        {/if}
      </div>

      {#if !isReply}
        {@const replies = comments.filter((c) => c.parentId === comment.id)}
        {#if replies.length > 0}
          <div
            class="pl-3 sm:pl-4 ml-2 sm:ml-3.5 mt-1 border-l-2 border-black/5 dark:border-white/10"
          >
            {#each replies as reply (reply.id)}
              {@render commentNode(reply, true)}
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/snippet}

{#if comments.length > 0 || showComments}
  <div
    class="border-t border-black/5 dark:border-white/10 px-4 sm:px-5 py-4 bg-white/30 dark:bg-black/10"
  >
    <!-- Contrôles : afficher/masquer + tri -->
    <div class="flex items-center justify-between mb-2 gap-2">
      <div>
        {#if topLevelComments.length > PREVIEW_COUNT && !showComments}
          <button
            type="button"
            onclick={onToggleComments}
            class="text-[0.75rem] font-bold text-text-muted hover:text-text-main flex items-center gap-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-lg px-2 py-1"
          >
            <ChevronDown size={16} strokeWidth={2.5} />
            Afficher les {topLevelComments.length} commentaires
          </button>
        {:else if showComments}
          <button
            type="button"
            onclick={onToggleComments}
            class="text-[0.75rem] font-bold text-text-muted hover:text-text-main flex items-center gap-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-lg px-2 py-1"
          >
            <ChevronUp size={16} strokeWidth={2.5} />
            Masquer
          </button>
        {/if}
      </div>

      <!-- Tri -->
      {#if topLevelComments.length > 1}
        <div class="flex items-center gap-1">
          <ArrowUpDown size={12} class="text-text-muted opacity-60" />
          {#each [['recent', 'Récents'], ['oldest', 'Anciens'], ['liked', 'Aimés']] as const as [mode, label] (mode)}
            <button
              type="button"
              onclick={() => (sortMode = mode)}
              class="text-[0.65rem] font-bold px-2 py-0.5 rounded-full transition-colors {sortMode ===
              mode
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                : 'text-text-muted hover:text-text-main'}"
            >
              {label}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Liste des commentaires -->
    <div class="space-y-1 mb-4">
      {#each visibleComments as comment (comment.id)}
        {@render commentNode(comment, false)}
      {/each}
    </div>

    <!-- Charger tous les commentaires (si backend en retourne plus) -->
    {#if onLoadAllComments && totalCommentCount !== undefined && totalCommentCount >= 20 && showComments}
      <button
        type="button"
        onclick={handleLoadAll}
        disabled={loadingAll}
        class="w-full text-[0.75rem] font-bold text-text-muted hover:text-text-main py-1.5 rounded-lg transition-colors disabled:opacity-50 mb-2"
      >
        {loadingAll ? 'Chargement…' : 'Charger tous les commentaires'}
      </button>
    {/if}

    <!-- Zone de saisie -->
    <div class="pt-3 flex flex-col gap-2">
      {#if replyingToId}
        <div
          class="flex items-center justify-between px-3 py-1.5 bg-amber-500/10 border border-amber-500/20 rounded-xl text-amber-700 dark:text-amber-400 text-[0.7rem] font-bold ml-10 animate-in fade-in slide-in-from-bottom-1"
        >
          <span class="flex items-center gap-1.5"
            ><CornerDownRight size={14} /> En réponse à {replyingToName}</span
          >
          <button
            onclick={cancelReply}
            class="hover:bg-amber-500/20 rounded-full p-1 transition-colors outline-none"
            aria-label="Annuler la réponse"
          >
            <X size={14} strokeWidth={2.5} />
          </button>
        </div>
      {/if}
      {@render commentInputRow(
        replyingToId ? 'Écrivez votre réponse...' : 'Ajouter un commentaire...'
      )}
    </div>
  </div>
{:else}
  <div
    class="border-t border-black/5 dark:border-white/10 px-4 sm:px-5 py-4 bg-white/30 dark:bg-black/10"
  >
    {@render commentInputRow('Soyez le premier à commenter...')}
  </div>
{/if}

{#snippet commentInputRow(placeholder: string)}
  <div class="relative">
    {#if pendingPreviewUrl || uploadingMedia}
      <div class="flex items-center gap-2 mb-2 ml-[2.125rem]">
        <div
          class="relative w-20 max-h-14 rounded-lg overflow-hidden bg-black/10 dark:bg-white/10 flex-shrink-0"
          style={pendingMedia?.width && pendingMedia?.height
            ? mediaAspectStyle(pendingMedia.width, pendingMedia.height)
            : 'aspect-ratio: 10/7'}
        >
          {#if pendingPreviewUrl}
            <img src={pendingPreviewUrl} alt="GIF" class="w-full h-full object-cover" />
          {:else}
            <div class="w-full h-full flex items-center justify-center">
              <ImageIcon size={20} class="opacity-30 animate-pulse" />
            </div>
          {/if}
          {#if !uploadingMedia}
            <button
              type="button"
              onclick={clearPendingMedia}
              class="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-red-500 transition-colors"
              aria-label="Supprimer l'image"
            >
              <X size={10} strokeWidth={3} />
            </button>
          {/if}
        </div>
        {#if uploadingMedia}
          <span class="text-[0.7rem] text-text-muted animate-pulse">Chargement…</span>
        {/if}
      </div>
    {/if}
    <div class="flex items-center gap-2.5">
      <div class="shrink-0"><Avatar userId={currentUserId} size="sm" /></div>
      <div
        class="flex-1 min-w-0 flex items-end bg-black/5 dark:bg-white/5 rounded-[1.25rem] px-3.5 py-1.5 border border-black/5 dark:border-white/10 focus-within:ring-2 focus-within:ring-amber-500/50 focus-within:bg-white dark:focus-within:bg-black/40 transition-all shadow-inner"
      >
        <MentionComposerInput
          value={commentText}
          onchange={(text) => onCommentTextChange(text)}
          {placeholder}
          singleLine
          class="flex-1 min-w-0"
          editorClass="flex-1 bg-transparent text-[0.9rem] font-medium text-text-main outline-none py-1 min-h-0"
          minHeight="0"
          onpaste={handleCommentPaste}
          onkeydown={handleInternalKeyDown}
        />
        <button
          type="button"
          onclick={handleSubmitComment}
          disabled={(!commentText.trim() && !pendingMedia) || submittingComment || uploadingMedia}
          class="shrink-0 p-1.5 ml-1 rounded-full text-amber-500 hover:bg-amber-500/10 hover:text-amber-600 disabled:opacity-40 disabled:hover:bg-transparent transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95"
          aria-label="Envoyer le commentaire"
        >
          <Send size={18} strokeWidth={2.5} class="ml-0.5 mt-0.5" />
        </button>
      </div>
    </div>
  </div>
{/snippet}
