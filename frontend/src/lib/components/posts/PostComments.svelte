<script lang="ts">
  import { ChevronDown, ChevronUp, Send, X, CornerDownRight } from 'lucide-svelte';
  import type { PostComment } from '$lib/posts/api';
  import Avatar from '$lib/components/shared/Avatar.svelte';

  interface Props {
    comments: PostComment[];
    topLevelComments: PostComment[];
    showComments: boolean;
    commentText: string;
    submittingComment: boolean;
    currentUserId: string;
    onToggleComments: () => void;
    onCommentTextChange: (text: string) => Promise<void>;
    onAddComment: (parentId?: string) => Promise<void>; // Modifié pour accepter un parentId
    onLikeComment: (commentId: string) => void;
    onKeyDown?: (e: KeyboardEvent) => void; // Optionnel car désormais géré en grande partie en interne
  }

  let {
    comments,
    topLevelComments,
    showComments,
    commentText,
    submittingComment,
    currentUserId,
    onToggleComments,
    onCommentTextChange,
    onAddComment,
    onLikeComment,
    onKeyDown,
  }: Props = $props();

  // --- Gestion des Réponses (Replies) ---
  let replyingToId = $state<string | null>(null);
  let replyingToName = $state<string>('');

  function initiateReply(comment: PostComment) {
    replyingToId = comment.id;
    replyingToName = getCommentAuthorName(comment);
  }

  function cancelReply() {
    replyingToId = null;
    replyingToName = '';
  }

  async function handleSubmitComment() {
    if (!commentText.trim() || submittingComment) return;
    await onAddComment(replyingToId ?? undefined);
    cancelReply();
  }

  function handleInternalKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmitComment();
    }
    if (e.key === 'Escape' && replyingToId) {
      cancelReply();
    }
    if (onKeyDown) onKeyDown(e);
  }
  // --------------------------------------

  function getCommentAuthorName(comment: PostComment): string {
    const first = comment.firstName?.trim();
    const last = comment.lastName?.trim();

    if (first && last) {
      return `${first} ${last}`;
    }
    if (first) {
      return first;
    }
    if (last) {
      return last;
    }
    if (comment.displayName?.trim()) {
      return comment.displayName.trim();
    }
    return comment.userId;
  }

  function timeAgo(dateStr: string): string {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diffSec = Math.floor((now - then) / 1000);
    if (diffSec < 60) return 'À l\u2019instant';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} min`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH} h`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return `${diffD} j`;
    return new Date(dateStr).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }
</script>

<!-- SNIPPET SVELTE 5 : Modèle de rendu d'un commentaire (réutilisable pour les réponses) -->
{#snippet commentNode(comment: PostComment, isReply: boolean)}
  <div class="flex items-start gap-2.5 {isReply ? 'mt-2.5' : 'mt-4'}">
    <!-- Avatar cliquable -->
    <a
      href="/profile/{encodeURIComponent(comment.userId)}"
      class="shrink-0 mt-0.5 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-full"
    >
      <Avatar userId={comment.userId} size="sm" />
    </a>

    <div class="flex-1 min-w-0">
      <!-- Bulle du commentaire -->
      <div
        class="bg-black/5 dark:bg-white/5 rounded-2xl rounded-tl-sm px-3.5 py-2.5 w-fit max-w-full border border-black/5 dark:border-white/5 shadow-sm"
      >
        <a
          href="/profile/{encodeURIComponent(comment.userId)}"
          class="font-bold text-[0.8rem] text-text-main hover:text-amber-500 transition-colors block mb-0.5 outline-none focus-visible:underline"
        >
          {getCommentAuthorName(comment)}
        </a>
        <span class="text-[0.9rem] text-text-main leading-snug break-words">
          {comment.text}
        </span>
      </div>

      <!-- Actions sous le commentaire (J'aime, Répondre, Date) -->
      <div class="flex items-center gap-3.5 px-2 mt-1">
        <span class="text-[0.65rem] font-bold text-text-muted opacity-80"
          >{timeAgo(comment.createdAt)}</span
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
      </div>

      <!-- Affichage des réponses imbriquées -->
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

<!-- ================= CONTENU PRINCIPAL ================= -->
{#if comments.length > 0 || showComments}
  <div
    class="border-t border-black/5 dark:border-white/10 px-4 sm:px-5 py-4 bg-white/30 dark:bg-black/10"
  >
    <!-- Boutons Afficher/Masquer -->
    {#if topLevelComments.length > 2 && !showComments}
      <button
        type="button"
        onclick={onToggleComments}
        class="text-[0.75rem] font-bold text-text-muted hover:text-text-main mb-2 flex items-center gap-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-lg px-2 py-1"
      >
        <ChevronDown size={16} strokeWidth={2.5} />
        Afficher les {topLevelComments.length} commentaires
      </button>
    {/if}

    {#if showComments}
      <button
        type="button"
        onclick={onToggleComments}
        class="text-[0.75rem] font-bold text-text-muted hover:text-text-main mb-2 flex items-center gap-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-lg px-2 py-1"
      >
        <ChevronUp size={16} strokeWidth={2.5} />
        Masquer les commentaires
      </button>
    {/if}

    <!-- Liste des commentaires -->
    <div class="space-y-1 mb-4">
      {#each showComments ? topLevelComments : topLevelComments.slice(-2) as comment (comment.id)}
        {@render commentNode(comment, false)}
      {/each}
    </div>

    <!-- Zone de Saisie du Commentaire / Réponse -->
    <div class="pt-3 flex flex-col gap-2">
      <!-- Indicateur de réponse (Badge) -->
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

      <!-- Champ de texte -->
      <div class="flex items-center gap-2.5">
        <div class="shrink-0">
          <Avatar userId={currentUserId} size="sm" />
        </div>
        <div
          class="flex-1 flex items-center bg-black/5 dark:bg-white/5 rounded-[1.25rem] px-3.5 py-1.5 border border-black/5 dark:border-white/10 focus-within:ring-2 focus-within:ring-amber-500/50 focus-within:bg-white dark:focus-within:bg-black/40 transition-all shadow-inner"
        >
          <input
            type="text"
            value={commentText}
            oninput={(e) => onCommentTextChange(e.currentTarget.value)}
            placeholder={replyingToId ? 'Écrivez votre réponse...' : 'Ajouter un commentaire...'}
            class="flex-1 bg-transparent text-[0.9rem] font-medium text-text-main placeholder:text-text-muted/70 outline-none py-1"
            onkeydown={handleInternalKeyDown}
          />
          <button
            type="button"
            onclick={handleSubmitComment}
            disabled={!commentText.trim() || submittingComment}
            class="shrink-0 p-1.5 ml-1 rounded-full text-amber-500 hover:bg-amber-500/10 hover:text-amber-600 disabled:opacity-40 disabled:hover:bg-transparent transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95"
            aria-label="Envoyer le commentaire"
          >
            <Send size={18} strokeWidth={2.5} class="ml-0.5 mt-0.5" />
          </button>
        </div>
      </div>
    </div>
  </div>
{:else}
  <!-- État vide : Seulement la zone de saisie -->
  <div
    class="border-t border-black/5 dark:border-white/10 px-4 sm:px-5 py-4 bg-white/30 dark:bg-black/10"
  >
    <div class="flex items-center gap-2.5">
      <div class="shrink-0">
        <Avatar userId={currentUserId} size="sm" />
      </div>
      <div
        class="flex-1 flex items-center bg-black/5 dark:bg-white/5 rounded-[1.25rem] px-3.5 py-1.5 border border-black/5 dark:border-white/10 focus-within:ring-2 focus-within:ring-amber-500/50 focus-within:bg-white dark:focus-within:bg-black/40 transition-all shadow-inner"
      >
        <input
          type="text"
          value={commentText}
          oninput={(e) => onCommentTextChange(e.currentTarget.value)}
          placeholder="Soyez le premier à commenter..."
          class="flex-1 bg-transparent text-[0.9rem] font-medium text-text-main placeholder:text-text-muted/70 outline-none py-1"
          onkeydown={handleInternalKeyDown}
        />
        <button
          type="button"
          onclick={handleSubmitComment}
          disabled={!commentText.trim() || submittingComment}
          class="shrink-0 p-1.5 ml-1 rounded-full text-amber-500 hover:bg-amber-500/10 hover:text-amber-600 disabled:opacity-40 disabled:hover:bg-transparent transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95"
          aria-label="Envoyer le commentaire"
        >
          <Send size={18} strokeWidth={2.5} class="ml-0.5 mt-0.5" />
        </button>
      </div>
    </div>
  </div>
{/if}
