<script lang="ts">
  import { onMount } from 'svelte';
  import {
    Pin,
    Trash2,
    RefreshCw,
    ShieldAlert,
    ChevronDown,
    ChevronUp,
    MessageSquare,
  } from '@lucide/svelte';
  import {
    getReportedPosts,
    getPost,
    deletePost as deletePostApi,
    deleteComment as deleteCommentApi,
    pinPost as pinPostApi,
    unpinPost as unpinPostApi,
    type ReportedPost,
    type PostComment,
  } from '$lib/posts/api';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { goto } from '$app/navigation';

  let posts = $state<ReportedPost[]>([]);
  let loading = $state(true);
  let error = $state('');
  let expandedPostId = $state<string | null>(null);
  let commentsByPost = $state<Record<string, PostComment[]>>({});
  let commentsLoading = $state<Record<string, boolean>>({});
  let feedback = $state<Record<string, string>>({});

  async function load() {
    loading = true;
    error = '';
    try {
      posts = await getReportedPosts();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Impossible de charger les signalements.';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    if (!isGlobalAdmin()) {
      void goto('/');
      return;
    }
    void load();
  });

  async function toggleComments(postId: string) {
    if (expandedPostId === postId) {
      expandedPostId = null;
      return;
    }
    expandedPostId = postId;
    if (commentsByPost[postId]) return;
    commentsLoading = { ...commentsLoading, [postId]: true };
    try {
      const full = await getPost(postId);
      commentsByPost = { ...commentsByPost, [postId]: full.comments ?? [] };
    } catch {
      commentsByPost = { ...commentsByPost, [postId]: [] };
    } finally {
      commentsLoading = { ...commentsLoading, [postId]: false };
    }
  }

  function setFeedback(postId: string, msg: string) {
    feedback = { ...feedback, [postId]: msg };
    setTimeout(() => {
      feedback = { ...feedback, [postId]: '' };
    }, 3000);
  }

  async function handleDelete(postId: string) {
    if (!confirm('Supprimer ce post définitivement ?')) return;
    try {
      await deletePostApi(postId);
      posts = posts.filter((p) => p.id !== postId);
    } catch (e) {
      setFeedback(postId, e instanceof Error ? e.message : 'Erreur');
    }
  }

  async function handleTogglePin(post: ReportedPost) {
    try {
      const res = post.pinned ? await unpinPostApi(post.id) : await pinPostApi(post.id);
      posts = posts.map((p) => (p.id === post.id ? { ...p, pinned: res.pinned } : p));
      setFeedback(post.id, res.pinned ? 'Post épinglé.' : 'Post désépinglé.');
    } catch (e) {
      setFeedback(post.id, e instanceof Error ? e.message : 'Erreur');
    }
  }

  async function handleDeleteComment(postId: string, commentId: string) {
    if (!confirm('Supprimer ce commentaire ?')) return;
    try {
      await deleteCommentApi(postId, commentId);
      commentsByPost = {
        ...commentsByPost,
        [postId]: (commentsByPost[postId] ?? []).filter(
          (c) => c.id !== commentId && c.parentId !== commentId
        ),
      };
      setFeedback(postId, 'Commentaire supprimé.');
    } catch (e) {
      setFeedback(postId, e instanceof Error ? e.message : 'Erreur');
    }
  }

  function excerpt(md: string): string {
    const plain = md.replace(/[#*`_~[\]()!]/g, '').trim();
    return plain.length > 140 ? plain.slice(0, 137) + '…' : plain;
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  }
</script>

<div class="max-w-3xl mx-auto px-4 py-8">
  <header class="mb-6 flex items-center justify-between gap-3">
    <div class="flex items-center gap-3">
      <ShieldAlert size={28} class="text-red-500" />
      <div>
        <h1 class="text-2xl font-bold text-text-main">Modération</h1>
        <p class="text-sm text-text-muted">Posts signalés par les utilisateurs</p>
      </div>
    </div>
    <button
      onclick={load}
      disabled={loading}
      class="p-2 rounded-xl border border-cn-border text-text-muted hover:text-text-main transition-colors disabled:opacity-40"
      aria-label="Rafraîchir"
    >
      <RefreshCw size={18} class={loading ? 'animate-spin' : ''} />
    </button>
  </header>

  {#if error}
    <div class="p-4 rounded-xl bg-red-50 text-red-700 border border-red-200 text-sm mb-6">
      {error}
    </div>
  {/if}

  {#if loading}
    <div class="space-y-4">
      {#each { length: 3 } as _, i (i)}
        <div class="rounded-2xl border border-cn-border bg-white/60 p-5 animate-pulse space-y-3">
          <div class="h-3 w-2/3 rounded bg-cn-border/60"></div>
          <div class="h-3 w-full rounded bg-cn-border/40"></div>
          <div class="h-3 w-1/2 rounded bg-cn-border/30"></div>
        </div>
      {/each}
    </div>
  {:else if posts.length === 0}
    <div class="text-center py-16 text-text-muted">
      <ShieldAlert size={40} class="mx-auto mb-3 opacity-30" />
      <p class="font-medium">Aucun post signalé pour le moment.</p>
    </div>
  {:else}
    <div class="space-y-5">
      {#each posts as post (post.id)}
        <div
          class="rounded-2xl border border-cn-border bg-white/70 backdrop-blur-sm overflow-hidden shadow-sm"
        >
          <!-- Post header -->
          <div class="flex items-start justify-between gap-3 p-4 border-b border-cn-border/50">
            <div class="min-w-0 flex-1">
              <p class="text-xs text-text-muted mb-1">
                {post.associationId
                  ? `Association ${post.associationId.slice(0, 8)}…`
                  : (post.authorId?.slice(0, 8) ?? '?') + '…'} · {formatDate(post.createdAt)}
                {#if post.pinned}
                  <span class="ml-2 inline-flex items-center gap-0.5 text-amber-600 font-semibold">
                    <Pin size={11} /> Épinglé
                  </span>
                {/if}
              </p>
              <p class="text-sm text-text-main leading-relaxed">{excerpt(post.markdown)}</p>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <button
                onclick={() => handleTogglePin(post)}
                class="p-1.5 rounded-lg border border-cn-border text-text-muted hover:text-amber-600 hover:border-amber-400 transition-colors"
                title={post.pinned ? 'Désépingler' : 'Épingler'}
              >
                <Pin size={15} />
              </button>
              <button
                onclick={() => handleDelete(post.id)}
                class="p-1.5 rounded-lg border border-cn-border text-text-muted hover:text-red-600 hover:border-red-400 transition-colors"
                title="Supprimer le post"
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>

          <!-- Reports -->
          <div class="px-4 py-3 bg-red-50/60 border-b border-cn-border/50">
            <p class="text-[11px] font-bold text-red-700 uppercase tracking-wider mb-2">
              {post.reports.length} signalement{post.reports.length > 1 ? 's' : ''}
            </p>
            <div class="space-y-1.5">
              {#each post.reports as report (report.userId + report.createdAt)}
                <div class="flex items-baseline gap-2 text-xs">
                  <span class="font-medium text-text-main truncate max-w-[180px] shrink-0"
                    >{report.userId.slice(0, 12)}…</span
                  >
                  <span class="text-red-700 italic min-w-0 truncate">"{report.reason}"</span>
                  <span class="ml-auto shrink-0 text-text-muted"
                    >{formatDate(report.createdAt)}</span
                  >
                </div>
              {/each}
            </div>
          </div>

          <!-- Feedback banner -->
          {#if feedback[post.id]}
            <div
              class="px-4 py-2 text-xs font-medium text-text-muted border-b border-cn-border/50 bg-amber-50/50"
            >
              {feedback[post.id]}
            </div>
          {/if}

          <!-- Comments toggle -->
          <button
            onclick={() => toggleComments(post.id)}
            class="w-full px-4 py-2.5 flex items-center justify-between text-xs text-text-muted hover:bg-black/5 transition-colors"
          >
            <span class="flex items-center gap-1.5">
              <MessageSquare size={13} />
              Commentaires
            </span>
            {#if expandedPostId === post.id}
              <ChevronUp size={14} />
            {:else}
              <ChevronDown size={14} />
            {/if}
          </button>

          <!-- Comments list -->
          {#if expandedPostId === post.id}
            <div class="border-t border-cn-border/50">
              {#if commentsLoading[post.id]}
                <div class="px-4 py-4 text-xs text-text-muted">Chargement…</div>
              {:else if (commentsByPost[post.id] ?? []).length === 0}
                <div class="px-4 py-4 text-xs text-text-muted">Aucun commentaire.</div>
              {:else}
                <div class="divide-y divide-cn-border/40">
                  {#each commentsByPost[post.id] as comment (comment.id)}
                    <div
                      class="flex items-start gap-3 px-4 py-3 {comment.parentId
                        ? 'pl-10 bg-black/[0.02]'
                        : ''}"
                    >
                      <div class="flex-1 min-w-0">
                        <p class="text-xs font-medium text-text-muted mb-0.5">
                          {comment.displayName ?? comment.userId?.slice(0, 10) + '…'} · {formatDate(
                            comment.createdAt
                          )}
                          {#if comment.parentId}<span class="text-text-muted/50">
                              (réponse)</span
                            >{/if}
                        </p>
                        <p class="text-sm text-text-main">{comment.text}</p>
                      </div>
                      <button
                        onclick={() => handleDeleteComment(post.id, comment.id)}
                        class="p-1 rounded text-text-muted hover:text-red-600 transition-colors shrink-0"
                        title="Supprimer"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
