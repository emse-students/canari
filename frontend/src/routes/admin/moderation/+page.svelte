<script lang="ts">
  import { onMount } from 'svelte';
  import {
    ShieldAlert,
    Flag,
    UserX,
    RefreshCw,
    Check,
    X,
    UserCheck,
    EyeOff,
    Eye,
    Trash2,
    Copy,
  } from '@lucide/svelte';
  import ModerationPostPreviewModal from '$lib/components/moderation/ModerationPostPreviewModal.svelte';
  import ModerationMuteDialog from '$lib/components/moderation/ModerationMuteDialog.svelte';
  import {
    listReports,
    reviewReport,
    muteUser,
    unmuteUser,
    listMutedUsers,
    deleteReportedComment,
    type ContentReport,
    type MutedUser,
  } from '$lib/moderation/api';
  import {
    listHiddenPosts,
    unhidePost,
    hidePost,
    deletePost,
    type HiddenPost,
  } from '$lib/posts/api';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { goto } from '$app/navigation';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';

  type Tab = 'reports' | 'hidden' | 'muted';

  let tab = $state<Tab>('reports');
  let reports = $state<ContentReport[]>([]);
  let mutedUsers = $state<MutedUser[]>([]);
  let hiddenPosts = $state<HiddenPost[]>([]);
  let loadingReports = $state(true);
  let loadingMuted = $state(false);
  let loadingHidden = $state(false);
  let error = $state('');
  let processingId = $state<string | null>(null);
  /** Resolved display names keyed by user ID. */
  let names = $state<Record<string, string>>({});
  let previewOpen = $state(false);
  let previewPostId = $state<string | null>(null);
  let muteDialogOpen = $state(false);
  let muteDialogLoading = $state(false);
  let muteDialogTarget = $state<{
    userId: string;
    displayName: string;
    reportId: string;
  } | null>(null);

  function openPostPreview(postId: string) {
    previewPostId = postId;
    previewOpen = true;
  }

  function closePostPreview() {
    previewOpen = false;
    previewPostId = null;
  }

  onMount(() => {
    if (!isGlobalAdmin()) {
      void goto('/');
      return;
    }
    void loadReports();
  });

  /** Resolves a set of user IDs to display names asynchronously. */
  async function resolveNames(ids: string[]) {
    const unique = [...new Set(ids.filter(Boolean))];
    for (const id of unique) {
      if (!names[id]) names = { ...names, [id]: getUserDisplayNameSync(id, id) };
    }
    for (const id of unique) {
      void resolveUserDisplayName(id).then((n) => {
        if (n) names = { ...names, [id]: n };
      });
    }
  }

  async function loadReports() {
    loadingReports = true;
    error = '';
    try {
      reports = await listReports();
      const ids = reports.flatMap((r) =>
        [r.reporterId, r.reportedUserId].filter((id): id is string => Boolean(id))
      );
      await resolveNames(ids);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Impossible de charger les signalements.';
    } finally {
      loadingReports = false;
    }
  }

  async function loadHidden() {
    loadingHidden = true;
    error = '';
    try {
      hiddenPosts = await listHiddenPosts();
      const ids = hiddenPosts.map((p) => p.authorId).filter((id): id is string => Boolean(id));
      await resolveNames(ids);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Impossible de charger les posts masqués.';
    } finally {
      loadingHidden = false;
    }
  }

  async function loadMuted() {
    loadingMuted = true;
    error = '';
    try {
      mutedUsers = await listMutedUsers();
      const ids = [
        ...mutedUsers.map((u) => u.userId),
        ...mutedUsers.filter((u) => u.mutedBy).map((u) => u.mutedBy!),
      ];
      await resolveNames(ids);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Impossible de charger les utilisateurs mutés.';
    } finally {
      loadingMuted = false;
    }
  }

  async function switchTab(t: Tab) {
    tab = t;
    error = '';
    if (t === 'muted' && mutedUsers.length === 0) void loadMuted();
    if (t === 'hidden' && hiddenPosts.length === 0) void loadHidden();
  }

  async function handleReview(reportId: string, action: 'reviewed' | 'dismissed') {
    processingId = reportId;
    try {
      const updated = await reviewReport(reportId, action);
      reports = reports.map((r) => (r.id === reportId ? updated : r));
    } catch (e) {
      error = e instanceof Error ? e.message : 'Erreur';
    } finally {
      processingId = null;
    }
  }

  function displayNameFor(userId: string): string {
    return names[userId] ?? `${userId.slice(0, 8)}…`;
  }

  function openMuteDialog(userId: string, displayName: string, reportId: string) {
    muteDialogTarget = { userId, displayName, reportId };
    muteDialogOpen = true;
  }

  function closeMuteDialog() {
    if (muteDialogLoading) return;
    muteDialogOpen = false;
    muteDialogTarget = null;
  }

  async function confirmMuteDialog(userVisibleReason: string) {
    if (!muteDialogTarget) return;
    muteDialogLoading = true;
    processingId = muteDialogTarget.reportId;
    error = '';
    try {
      await muteUser(muteDialogTarget.userId, userVisibleReason);
      await handleReview(muteDialogTarget.reportId, 'reviewed');
      muteDialogOpen = false;
      muteDialogTarget = null;
      if (tab === 'muted') void loadMuted();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Erreur lors du mute.';
    } finally {
      muteDialogLoading = false;
      processingId = null;
    }
  }

  async function handleHidePost(report: ContentReport) {
    if (report.contentType !== 'post') return;
    processingId = report.id;
    error = '';
    try {
      await hidePost(report.contentId);
      await handleReview(report.id, 'reviewed');
      if (tab === 'hidden') void loadHidden();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Erreur lors du masquage.';
      processingId = null;
    }
  }

  async function handleDeletePost(report: ContentReport) {
    if (report.contentType !== 'post') return;
    if (!await showConfirm('Supprimer définitivement cette publication ?', { danger: true, confirmLabel: 'Supprimer' })) return;
    processingId = report.id;
    error = '';
    try {
      await deletePost(report.contentId);
      await handleReview(report.id, 'reviewed');
      hiddenPosts = hiddenPosts.filter((p) => p.id !== report.contentId);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Erreur lors de la suppression.';
      processingId = null;
    }
  }

  async function handleDeleteComment(report: ContentReport) {
    if (report.contentType !== 'comment') return;
    if (!await showConfirm('Supprimer ce commentaire et ses réponses ?', { danger: true, confirmLabel: 'Supprimer' })) return;
    processingId = report.id;
    error = '';
    try {
      await deleteReportedComment(report.contentId);
      await handleReview(report.id, 'reviewed');
    } catch (e) {
      error = e instanceof Error ? e.message : 'Erreur lors de la suppression du commentaire.';
      processingId = null;
    }
  }

  async function handleUnmute(userId: string) {
    processingId = userId;
    try {
      await unmuteUser(userId);
      mutedUsers = mutedUsers.filter((u) => u.userId !== userId);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Erreur';
    } finally {
      processingId = null;
    }
  }

  async function handleRestore(postId: string) {
    processingId = postId;
    try {
      await unhidePost(postId);
      hiddenPosts = hiddenPosts.filter((p) => p.id !== postId);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Erreur lors de la restauration.';
    } finally {
      processingId = null;
    }
  }

  async function handleDeleteHidden(postId: string) {
    processingId = postId;
    try {
      await deletePost(postId);
      hiddenPosts = hiddenPosts.filter((p) => p.id !== postId);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Erreur lors de la suppression.';
    } finally {
      processingId = null;
    }
  }

  function copyId(id: string) {
    void navigator.clipboard.writeText(id);
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  }

  function excerpt(markdown: string, max = 220): string {
    const plain = markdown.replace(/[#*`_~[\]]/g, '').trim();
    return plain.length > max ? plain.slice(0, max) + '…' : plain;
  }

  const reasonLabel: Record<string, string> = {
    spam: 'Spam',
    harassment: 'Harcèlement',
    inappropriate: 'Contenu inapproprié',
    other: 'Autre',
  };

  const statusLabel: Record<ContentReport['status'], string> = {
    pending: 'En attente',
    reviewed: 'Traité',
    dismissed: 'Ignoré',
  };

  const statusClass: Record<ContentReport['status'], string> = {
    pending: 'bg-amber-100 text-amber-700',
    reviewed: 'bg-green-100 text-green-700',
    dismissed: 'bg-gray-100 text-text-muted',
  };

  const contentTypeLabel: Record<ContentReport['contentType'], string> = {
    post: 'Post',
    comment: 'Commentaire',
    message: 'Message',
  };

  const pendingReports = $derived(reports.filter((r) => r.status === 'pending'));
  const resolvedReports = $derived(reports.filter((r) => r.status !== 'pending'));
</script>

<div class="max-w-3xl mx-auto px-4 py-8">
  <header class="mb-6 flex items-center justify-between gap-3">
    <div class="flex items-center gap-3">
      <ShieldAlert size={28} class="text-red-500" />
      <div>
        <h1 class="text-2xl font-bold text-text-main">Modération</h1>
        <p class="text-sm text-text-muted">
          Signalements, posts masqués et utilisateurs restreints
        </p>
      </div>
    </div>
    <button
      onclick={() => {
        if (tab === 'reports') void loadReports();
        else if (tab === 'hidden') void loadHidden();
        else void loadMuted();
      }}
      disabled={loadingReports || loadingHidden || loadingMuted}
      class="p-2 rounded-xl border border-cn-border text-text-muted hover:text-text-main transition-colors disabled:opacity-40"
      aria-label="Rafraîchir"
    >
      <RefreshCw
        size={18}
        class={loadingReports || loadingHidden || loadingMuted ? 'animate-spin' : ''}
      />
    </button>
  </header>

  <!-- Tabs -->
  <div class="flex gap-1 p-1 bg-black/5 rounded-xl mb-6">
    <button
      onclick={() => switchTab('reports')}
      class="flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-lg transition-colors {tab ===
      'reports'
        ? 'bg-white shadow-sm text-text-main'
        : 'text-text-muted hover:text-text-main'}"
    >
      <Flag size={16} />
      Signalements
      {#if pendingReports.length > 0}
        <span class="ml-1 px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-red-500 text-white">
          {pendingReports.length}
        </span>
      {/if}
    </button>
    <button
      onclick={() => switchTab('hidden')}
      class="flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-lg transition-colors {tab ===
      'hidden'
        ? 'bg-white shadow-sm text-text-main'
        : 'text-text-muted hover:text-text-main'}"
    >
      <EyeOff size={16} />
      Posts masqués
      {#if hiddenPosts.length > 0}
        <span
          class="ml-1 px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-orange-500 text-white"
        >
          {hiddenPosts.length}
        </span>
      {/if}
    </button>
    <button
      onclick={() => switchTab('muted')}
      class="flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-lg transition-colors {tab ===
      'muted'
        ? 'bg-white shadow-sm text-text-main'
        : 'text-text-muted hover:text-text-main'}"
    >
      <UserX size={16} />
      Utilisateurs mutés
      {#if mutedUsers.length > 0}
        <span class="ml-1 px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-gray-500 text-white">
          {mutedUsers.length}
        </span>
      {/if}
    </button>
  </div>

  {#if error}
    <div class="p-4 rounded-xl bg-red-50 text-red-700 border border-red-200 text-sm mb-6">
      {error}
    </div>
  {/if}

  <!-- ── Reports tab ────────────────────────────────────────────────────────── -->
  {#if tab === 'reports'}
    {#if loadingReports}
      <div class="space-y-3">
        {#each { length: 3 } as _, i (i)}
          <div class="rounded-2xl border border-cn-border bg-white/60 p-5 animate-pulse space-y-2">
            <div class="h-3 w-2/3 rounded bg-cn-border/60"></div>
            <div class="h-3 w-full rounded bg-cn-border/40"></div>
          </div>
        {/each}
      </div>
    {:else if reports.length === 0}
      <div class="text-center py-16 text-text-muted">
        <Flag size={40} class="mx-auto mb-3 opacity-30" />
        <p class="font-medium">Aucun signalement pour le moment.</p>
      </div>
    {:else}
      <!-- Pending reports -->
      {#if pendingReports.length > 0}
        <h2 class="text-sm font-bold text-text-muted uppercase tracking-wider mb-3">
          En attente - {pendingReports.length}
        </h2>
        <div class="space-y-3 mb-8">
          {#each pendingReports as report (report.id)}
            <div
              class="rounded-2xl border border-cn-border bg-white/70 backdrop-blur-sm p-4 shadow-sm"
            >
              <!-- Header row -->
              <div class="flex items-center gap-2 flex-wrap mb-3">
                <span
                  class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-cn-border/40 text-text-muted"
                >
                  {contentTypeLabel[report.contentType]}
                </span>
                <span
                  class="text-[11px] font-semibold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full"
                >
                  {reasonLabel[report.reason] ?? report.reason}
                </span>
                <span class="ml-auto text-[11px] text-text-muted/60"
                  >{formatDate(report.createdAt)}</span
                >
              </div>

              <!-- People row -->
              <div class="space-y-1.5 mb-3">
                <div class="flex items-center gap-2 text-xs text-text-muted">
                  <Flag size={12} class="shrink-0 opacity-60" />
                  <span>
                    Signalé par :
                    <span class="font-medium text-text-main">
                      {names[report.reporterId] ?? report.reporterId.slice(0, 8) + '…'}
                    </span>
                  </span>
                </div>
                {#if report.reportedUserId}
                  <div class="flex items-center gap-2 text-xs text-text-muted">
                    <UserX size={12} class="shrink-0 opacity-60" />
                    <span>
                      Auteur du contenu :
                      <span class="font-medium text-text-main">
                        {names[report.reportedUserId] ?? report.reportedUserId.slice(0, 8) + '…'}
                      </span>
                    </span>
                  </div>
                {/if}
              </div>

              <!-- Details -->
              {#if report.details}
                <p class="text-xs text-text-muted italic bg-black/5 rounded-lg px-3 py-2 mb-3">
                  "{report.details}"
                </p>
              {/if}

              <!-- Content ID + link -->
              <div class="flex items-center gap-2 mb-3">
                <code class="text-[10px] text-text-muted/50 font-mono flex-1 truncate">
                  {report.contentId}
                </code>
                <button
                  onclick={() => copyId(report.contentId)}
                  class="p-1 rounded text-text-muted/50 hover:text-text-muted transition-colors"
                  title="Copier l'ID"
                >
                  <Copy size={11} />
                </button>
                {#if report.contentType === 'post'}
                  <button
                    type="button"
                    onclick={() => openPostPreview(report.contentId)}
                    class="flex items-center gap-1 text-[11px] font-semibold text-cn-yellow hover:underline"
                    title="Aperçu de la publication"
                  >
                    <Eye size={11} />
                    Voir
                  </button>
                {/if}
              </div>

              <!-- Actions -->
              <div class="pt-2 border-t border-cn-border/40 space-y-2">
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onclick={() => handleReview(report.id, 'reviewed')}
                    disabled={processingId === report.id}
                    class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-cn-border text-text-muted hover:text-green-600 hover:border-green-400 transition-colors disabled:opacity-40"
                  >
                    <Check size={13} />
                    Marquer traité
                  </button>
                  <button
                    type="button"
                    onclick={() => handleReview(report.id, 'dismissed')}
                    disabled={processingId === report.id}
                    class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-cn-border text-text-muted hover:text-gray-600 hover:border-gray-400 transition-colors disabled:opacity-40"
                  >
                    <X size={13} />
                    Ignorer
                  </button>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onclick={() =>
                      openMuteDialog(
                        report.reporterId,
                        displayNameFor(report.reporterId),
                        report.id
                      )}
                    disabled={processingId === report.id}
                    class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-cn-border text-text-muted hover:text-orange-600 hover:border-orange-400 transition-colors disabled:opacity-40"
                    title="Restreindre le compte de la personne qui a signalé"
                  >
                    <UserX size={13} />
                    Muter le signaleur
                  </button>
                  {#if report.reportedUserId}
                    <button
                      type="button"
                      onclick={() =>
                        openMuteDialog(
                          report.reportedUserId!,
                          displayNameFor(report.reportedUserId!),
                          report.id
                        )}
                      disabled={processingId === report.id}
                      class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-cn-border text-text-muted hover:text-red-600 hover:border-red-400 transition-colors disabled:opacity-40"
                      title="Restreindre l'auteur du contenu signalé"
                    >
                      <UserX size={13} />
                      Muter l'auteur
                    </button>
                  {/if}
                </div>
                {#if report.contentType === 'post'}
                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onclick={() => handleHidePost(report)}
                      disabled={processingId === report.id}
                      class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-cn-border text-text-muted hover:text-amber-600 hover:border-amber-400 transition-colors disabled:opacity-40"
                    >
                      <EyeOff size={13} />
                      Masquer le post
                    </button>
                    <button
                      type="button"
                      onclick={() => handleDeletePost(report)}
                      disabled={processingId === report.id}
                      class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-cn-border text-text-muted hover:text-red-600 hover:border-red-400 transition-colors disabled:opacity-40"
                    >
                      <Trash2 size={13} />
                      Supprimer le post
                    </button>
                  </div>
                {:else if report.contentType === 'comment'}
                  <button
                    type="button"
                    onclick={() => handleDeleteComment(report)}
                    disabled={processingId === report.id}
                    class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-cn-border text-text-muted hover:text-red-600 hover:border-red-400 transition-colors disabled:opacity-40"
                  >
                    <Trash2 size={13} />
                    Supprimer le commentaire
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}

      <!-- Resolved reports -->
      {#if resolvedReports.length > 0}
        <h2 class="text-sm font-bold text-text-muted uppercase tracking-wider mb-3">
          Traités / Ignorés - {resolvedReports.length}
        </h2>
        <div class="space-y-2">
          {#each resolvedReports as report (report.id)}
            <div class="rounded-xl border border-cn-border bg-white/40 p-3 flex items-center gap-3">
              <span
                class="text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 {statusClass[
                  report.status
                ]}"
              >
                {statusLabel[report.status]}
              </span>
              <span class="text-xs text-text-muted">
                {contentTypeLabel[report.contentType]} · {reasonLabel[report.reason] ??
                  report.reason}
              </span>
              {#if report.reportedUserId}
                <span class="text-xs text-text-muted hidden sm:inline">
                  - {names[report.reportedUserId] ?? report.reportedUserId.slice(0, 8) + '…'}
                </span>
              {/if}
              {#if report.contentType === 'post'}
                <button
                  type="button"
                  onclick={() => openPostPreview(report.contentId)}
                  class="flex items-center gap-1 text-[11px] text-cn-yellow hover:underline shrink-0"
                  title="Aperçu de la publication"
                >
                  <Eye size={11} />
                </button>
              {/if}
              <span class="ml-auto text-[11px] text-text-muted/60 shrink-0"
                >{formatDate(report.createdAt)}</span
              >
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  {/if}

  <!-- ── Hidden posts tab ───────────────────────────────────────────────────── -->
  {#if tab === 'hidden'}
    {#if loadingHidden}
      <div class="space-y-3">
        {#each { length: 3 } as _, i (i)}
          <div class="rounded-2xl border border-cn-border bg-white/60 p-5 animate-pulse space-y-2">
            <div class="h-3 w-1/2 rounded bg-cn-border/60"></div>
            <div class="h-3 w-full rounded bg-cn-border/40"></div>
            <div class="h-3 w-3/4 rounded bg-cn-border/30"></div>
          </div>
        {/each}
      </div>
    {:else if hiddenPosts.length === 0}
      <div class="text-center py-16 text-text-muted">
        <EyeOff size={40} class="mx-auto mb-3 opacity-30" />
        <p class="font-medium">Aucun post masqué actuellement.</p>
        <p class="text-sm mt-1">
          Les posts atteignant 5 signalements sont automatiquement masqués ici.
        </p>
      </div>
    {:else}
      <p class="text-xs text-text-muted mb-4">
        Ces posts ont été masqués automatiquement après avoir atteint 5 signalements. Ils ne sont
        plus visibles dans les fils d'actualité. Restaurez-les si le signalement est infondé, ou
        supprimez-les s'il est justifié.
      </p>
      <div class="space-y-3">
        {#each hiddenPosts as post (post.id)}
          <div
            class="rounded-2xl border border-orange-200 bg-orange-50/50 dark:bg-orange-950/20 dark:border-orange-900/40 p-4 shadow-sm"
          >
            <!-- Meta -->
            <div class="flex items-center gap-2 flex-wrap mb-2">
              {#if post.authorId}
                <div class="flex items-center gap-1.5">
                  <Avatar userId={post.authorId} size="xs" />
                  <span class="text-xs font-medium text-text-main">
                    {names[post.authorId] ?? post.authorId.slice(0, 8) + '…'}
                  </span>
                </div>
              {:else}
                <span class="text-xs text-text-muted italic">Publication d'association</span>
              {/if}
              <span class="ml-auto text-[11px] text-text-muted/60"
                >{formatDate(post.createdAt)}</span
              >
            </div>

            <!-- Excerpt -->
            <button
              type="button"
              onclick={() => openPostPreview(post.id)}
              class="text-left w-full text-sm text-text-main leading-relaxed mb-3 hover:opacity-90 transition-opacity"
              title="Aperçu complet"
            >
              {excerpt(post.markdown)}
            </button>

            <!-- Report count + ID -->
            <div class="flex items-center gap-2 mb-3">
              <span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-600">
                {post.pendingReportCount} signalement{post.pendingReportCount > 1 ? 's' : ''} en attente
              </span>
              <button
                onclick={() => copyId(post.id)}
                class="flex items-center gap-1 text-[10px] text-text-muted/50 hover:text-text-muted font-mono transition-colors"
                title="Copier l'ID"
              >
                {post.id.slice(0, 12)}…
                <Copy size={10} />
              </button>
            </div>

            <!-- Actions -->
            <div
              class="flex items-center gap-2 pt-2 border-t border-orange-200/60 dark:border-orange-900/30"
            >
              <button
                type="button"
                onclick={() => openPostPreview(post.id)}
                class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-cn-border text-text-muted hover:text-cn-yellow hover:border-amber-400 transition-colors"
                title="Aperçu complet de la publication"
              >
                <Eye size={13} />
                Aperçu
              </button>
              <button
                onclick={() => handleRestore(post.id)}
                disabled={processingId === post.id}
                class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-cn-border text-text-muted hover:text-green-600 hover:border-green-400 transition-colors disabled:opacity-40"
                title="Remettre le post dans les fils d'actualité"
              >
                Restaurer
              </button>
              {#if post.authorId}
                <button
                  onclick={async () => {
                    processingId = post.id;
                    try {
                      await muteUser(post.authorId!);
                    } catch {
                      /* already muted is fine */
                    }
                    await handleDeleteHidden(post.id);
                  }}
                  disabled={processingId === post.id}
                  class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-cn-border text-text-muted hover:text-orange-600 hover:border-orange-400 transition-colors disabled:opacity-40"
                  title="Supprime le post et mute l'auteur"
                >
                  <UserX size={13} />
                  Supprimer + muter
                </button>
              {/if}
              <button
                onclick={() => handleDeleteHidden(post.id)}
                disabled={processingId === post.id}
                class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-cn-border text-text-muted hover:text-red-600 hover:border-red-400 transition-colors disabled:opacity-40 ml-auto"
                title="Supprime définitivement le post"
              >
                <Trash2 size={13} />
                Supprimer
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}

  <!-- ── Muted users tab ────────────────────────────────────────────────────── -->
  {#if tab === 'muted'}
    {#if loadingMuted}
      <div class="space-y-3">
        {#each { length: 3 } as _, i (i)}
          <div class="rounded-2xl border border-cn-border bg-white/60 p-5 animate-pulse space-y-2">
            <div class="h-3 w-2/3 rounded bg-cn-border/60"></div>
          </div>
        {/each}
      </div>
    {:else if mutedUsers.length === 0}
      <div class="text-center py-16 text-text-muted">
        <UserCheck size={40} class="mx-auto mb-3 opacity-30" />
        <p class="font-medium">Aucun utilisateur muté actuellement.</p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each mutedUsers as user (user.userId)}
          <div
            class="rounded-2xl border border-cn-border bg-white/70 backdrop-blur-sm p-4 shadow-sm flex items-start gap-3"
          >
            <div class="shrink-0 mt-0.5"><Avatar userId={user.userId} size="sm" /></div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-text-main">
                {names[user.userId] ?? user.userId}
              </p>
              <p class="text-[11px] font-mono text-text-muted/50">{user.userId.slice(0, 16)}…</p>
              {#if user.mutedReason}
                <p class="text-xs text-text-muted mt-0.5 italic">"{user.mutedReason}"</p>
              {/if}
              {#if user.mutedAt}
                <p class="text-[11px] text-text-muted/60 mt-1">
                  Muté le {formatDate(user.mutedAt)}
                  {#if user.mutedBy}
                    par {names[user.mutedBy] ?? user.mutedBy.slice(0, 8) + '…'}
                  {/if}
                </p>
              {/if}
            </div>
            <button
              onclick={() => handleUnmute(user.userId)}
              disabled={processingId === user.userId}
              class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-cn-border text-text-muted hover:text-green-600 hover:border-green-400 transition-colors disabled:opacity-40"
            >
              <UserCheck size={14} />
              Démuter
            </button>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<ModerationPostPreviewModal open={previewOpen} postId={previewPostId} onClose={closePostPreview} />

<ModerationMuteDialog
  open={muteDialogOpen}
  targetLabel={muteDialogTarget?.displayName ?? ''}
  loading={muteDialogLoading}
  onClose={closeMuteDialog}
  onConfirm={confirmMuteDialog}
/>
