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
    ExternalLink,
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
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

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
      error = e instanceof Error ? e.message : m.moderation_load_reports_error();
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
      error = e instanceof Error ? e.message : m.moderation_load_hidden_posts_error();
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
      error = e instanceof Error ? e.message : m.moderation_load_muted_users_error();
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
      error = e instanceof Error ? e.message : m.common_generic_error_label();
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
      error = e instanceof Error ? e.message : m.moderation_mute_error();
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
      error = e instanceof Error ? e.message : m.moderation_hide_error();
      processingId = null;
    }
  }

  async function handleDeletePost(report: ContentReport) {
    if (report.contentType !== 'post') return;
    if (!await showConfirm(m.moderation_delete_post_confirm(), { danger: true, confirmLabel: m.moderation_supprimer() })) return;
    processingId = report.id;
    error = '';
    try {
      await deletePost(report.contentId);
      await handleReview(report.id, 'reviewed');
      hiddenPosts = hiddenPosts.filter((p) => p.id !== report.contentId);
    } catch (e) {
      error = e instanceof Error ? e.message : m.moderation_delete_error();
      processingId = null;
    }
  }

  async function handleDeleteComment(report: ContentReport) {
    if (report.contentType !== 'comment') return;
    if (!await showConfirm(m.moderation_delete_comment_confirm(), { danger: true, confirmLabel: m.moderation_supprimer() })) return;
    processingId = report.id;
    error = '';
    try {
      await deleteReportedComment(report.contentId);
      await handleReview(report.id, 'reviewed');
    } catch (e) {
      error = e instanceof Error ? e.message : m.moderation_delete_comment_error();
      processingId = null;
    }
  }

  async function handleUnmute(userId: string) {
    processingId = userId;
    try {
      await unmuteUser(userId);
      mutedUsers = mutedUsers.filter((u) => u.userId !== userId);
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_generic_error_label();
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
      error = e instanceof Error ? e.message : m.moderation_restore_error();
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
      error = e instanceof Error ? e.message : m.moderation_delete_error();
    } finally {
      processingId = null;
    }
  }

  function copyId(id: string) {
    void navigator.clipboard.writeText(id);
  }

  function formatDate(iso: string): string {
    const locale = getLocale() === 'en' ? 'en-US' : 'fr-FR';
    return new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
  }

  function excerpt(markdown: string, max = 220): string {
    const plain = markdown.replace(/[#*`_~[\]]/g, '').trim();
    return plain.length > max ? plain.slice(0, max) + '…' : plain;
  }

  const reasonLabel: Record<string, string> = $derived({
    spam: m.moderation_reason_spam(),
    harassment: m.moderation_reason_harassment(),
    inappropriate: m.moderation_reason_inappropriate(),
    other: m.moderation_reason_other(),
  });

  const statusLabel: Record<ContentReport['status'], string> = $derived({
    pending: m.moderation_pending(),
    reviewed: m.moderation_reviewed(),
    dismissed: m.moderation_dismissed(),
  });

  const statusClass: Record<ContentReport['status'], string> = {
    pending: 'bg-amber-100 text-amber-700',
    reviewed: 'bg-green-100 text-green-700',
    dismissed: 'bg-gray-100 text-text-muted',
  };

  const contentTypeLabel: Record<ContentReport['contentType'], string> = $derived({
    post: m.moderation_post(),
    comment: m.moderation_comment(),
    message: m.moderation_message(),
  });

  const pendingReports = $derived(reports.filter((r) => r.status === 'pending'));
  const resolvedReports = $derived(reports.filter((r) => r.status !== 'pending'));
</script>

<div class="max-w-3xl mx-auto px-4 py-8">
  <header class="mb-6 flex items-center justify-between gap-3">
    <div class="flex items-center gap-3">
      <ShieldAlert size={28} class="text-red-500" />
      <div>
        <h1 class="text-2xl font-bold text-text-main">{m.moderation_title()}</h1>
        <p class="text-sm text-text-muted">
          {m.moderation_subtitle()}
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
      aria-label={m.moderation_refresh()}
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
      {m.moderation_reports_tab()}
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
      {m.moderation_hidden_tab()}
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
      {m.moderation_muted_tab()}
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
        <p class="font-medium">{m.moderation_no_reports()}</p>
      </div>
    {:else}
      <!-- Pending reports -->
      {#if pendingReports.length > 0}
        <h2 class="text-sm font-bold text-text-muted uppercase tracking-wider mb-3">
          {m.moderation_pending_header_label({ count: pendingReports.length })}
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
                    {m.moderation_signale_par()} :
                    <span class="font-medium text-text-main">
                      {names[report.reporterId] ?? report.reporterId.slice(0, 8) + '…'}
                    </span>
                  </span>
                </div>
                {#if report.reportedUserId}
                  <div class="flex items-center gap-2 text-xs text-text-muted">
                    <UserX size={12} class="shrink-0 opacity-60" />
                    <span>
                      {m.moderation_auteur_contenu()} :
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

              <!-- Content preview -->
              {#if report.contentPreview}
                <div class="rounded-lg bg-black/5 px-3 py-2 mb-3">
                  {#if report.contentType === 'post'}
                    <button
                      type="button"
                      onclick={() => openPostPreview(report.contentId)}
                      class="text-left w-full text-xs text-text-main leading-relaxed hover:opacity-80 transition-opacity"
                      title={m.moderation_preview_full_label()}
                    >
                      {excerpt(report.contentPreview, 200)}
                    </button>
                  {:else}
                    <p class="text-xs text-text-main leading-relaxed">
                      {excerpt(report.contentPreview, 180)}
                    </p>
                  {/if}
                </div>
              {/if}

              <!-- ID + navigation -->
              <div class="flex items-center gap-2 mb-3">
                <button
                  onclick={() => copyId(report.contentId)}
                  class="flex items-center gap-1 text-[10px] text-text-muted/50 hover:text-text-muted font-mono transition-colors"
                  title={m.moderation_copy_id_label()}
                >
                  {report.contentId.slice(0, 8)}…
                  <Copy size={10} />
                </button>
                {#if report.contentType === 'post'}
                  <button
                    type="button"
                    onclick={() => openPostPreview(report.contentId)}
                    class="flex items-center gap-1 text-[11px] font-semibold text-cn-yellow hover:underline ml-auto"
                    title={m.moderation_preview_post_label()}
                  >
                    <Eye size={11} />
                    {m.moderation_apercu()}
                  </button>
                  <a
                    href="/posts/{report.contentId}"
                    target="_blank"
                    class="flex items-center gap-1 text-[11px] font-semibold text-text-muted hover:text-text-main"
                    title={m.moderation_open_post_label()}
                  >
                    <ExternalLink size={11} />
                    {m.moderation_ouvrir()}
                  </a>
                {:else if report.contentType === 'comment' && report.postId}
                  <a
                    href="/posts/{report.postId}"
                    target="_blank"
                    class="flex items-center gap-1 text-[11px] font-semibold text-text-muted hover:text-text-main ml-auto"
                    title={m.moderation_open_post_with_comment_label()}
                  >
                    <ExternalLink size={11} />
                    {m.moderation_voir_post_label()}
                  </a>
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
                    {m.moderation_marquer_traite()}
                  </button>
                  <button
                    type="button"
                    onclick={() => handleReview(report.id, 'dismissed')}
                    disabled={processingId === report.id}
                    class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-cn-border text-text-muted hover:text-gray-600 hover:border-gray-400 transition-colors disabled:opacity-40"
                  >
                    <X size={13} />
                    {m.moderation_ignorer()}
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
                    title={m.moderation_mute_reporter_hint()}
                  >
                    <UserX size={13} />
                    {m.moderation_muter_signaleur()}
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
                      title={m.moderation_mute_author_hint()}
                    >
                      <UserX size={13} />
                      {m.moderation_muter_auteur()}
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
                      {m.moderation_masquer_post()}
                    </button>
                    <button
                      type="button"
                      onclick={() => handleDeletePost(report)}
                      disabled={processingId === report.id}
                      class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-cn-border text-text-muted hover:text-red-600 hover:border-red-400 transition-colors disabled:opacity-40"
                    >
                      <Trash2 size={13} />
                      {m.moderation_supprimer_post()}
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
                    {m.moderation_supprimer_commentaire()}
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
          {m.moderation_resolved_header_label({ count: resolvedReports.length })}
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
                  title={m.moderation_preview_post_label()}
                >
                  <Eye size={11} />
                </button>
                <a
                  href="/posts/{report.contentId}"
                  target="_blank"
                  class="text-[11px] text-text-muted/60 hover:text-text-muted shrink-0"
                  title={m.moderation_open_post_label()}
                >
                  <ExternalLink size={11} />
                </a>
              {:else if report.contentType === 'comment' && report.postId}
                <a
                  href="/posts/{report.postId}"
                  target="_blank"
                  class="text-[11px] text-text-muted/60 hover:text-text-muted shrink-0"
                  title={m.moderation_open_post_short_label()}
                >
                  <ExternalLink size={11} />
                </a>
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
        <p class="font-medium">{m.moderation_no_hidden()}</p>
        <p class="text-sm mt-1">
          {m.moderation_auto_hide_hint()}
        </p>
      </div>
    {:else}
      <p class="text-xs text-text-muted mb-4">
        {m.moderation_hidden_desc()}
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
                <span class="text-xs text-text-muted italic">{m.moderation_association_post_label()}</span>
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
              title={m.moderation_preview_full_short_label()}
            >
              {excerpt(post.markdown)}
            </button>

            <!-- Report count + ID -->
            <div class="flex items-center gap-2 mb-3">
              <span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-600">
                {m.moderation_pending_reports_count_label({ count: post.pendingReportCount })}
              </span>
              <button
                onclick={() => copyId(post.id)}
                class="flex items-center gap-1 text-[10px] text-text-muted/50 hover:text-text-muted font-mono transition-colors"
                title={m.moderation_copy_id_label()}
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
                title={m.moderation_preview_full_label()}
              >
                <Eye size={13} />
                {m.moderation_apercu()}
              </button>
              <button
                onclick={() => handleRestore(post.id)}
                disabled={processingId === post.id}
                class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-cn-border text-text-muted hover:text-green-600 hover:border-green-400 transition-colors disabled:opacity-40"
                title={m.moderation_restore_hint()}
              >
                {m.moderation_restaurer()}
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
                  title={m.moderation_delete_mute_hint()}
                >
                  <UserX size={13} />
                  {m.moderation_supprimer_muter()}
                </button>
              {/if}
              <button
                onclick={() => handleDeleteHidden(post.id)}
                disabled={processingId === post.id}
                class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-cn-border text-text-muted hover:text-red-600 hover:border-red-400 transition-colors disabled:opacity-40 ml-auto"
                title={m.moderation_delete_permanently_hint()}
              >
                <Trash2 size={13} />
                {m.moderation_supprimer()}
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
        <p class="font-medium">{m.moderation_no_muted()}</p>
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
                  {m.moderation_muted_on_label({ date: formatDate(user.mutedAt) })}
                  {#if user.mutedBy}
                    {m.moderation_muted_by_label({ name: names[user.mutedBy] ?? user.mutedBy.slice(0, 8) + '…' })}
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
              {m.moderation_demuter()}
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
