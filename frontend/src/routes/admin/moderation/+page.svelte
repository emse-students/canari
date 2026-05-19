<script lang="ts">
  import { onMount } from 'svelte';
  import { ShieldAlert, Flag, UserX, RefreshCw, Check, X, UserCheck } from '@lucide/svelte';
  import {
    listReports,
    reviewReport,
    muteUser,
    unmuteUser,
    listMutedUsers,
    type ContentReport,
    type MutedUser,
  } from '$lib/moderation/api';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { goto } from '$app/navigation';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';

  type Tab = 'reports' | 'muted';

  let tab = $state<Tab>('reports');
  let reports = $state<ContentReport[]>([]);
  let mutedUsers = $state<MutedUser[]>([]);
  let loadingReports = $state(true);
  let loadingMuted = $state(false);
  let error = $state('');
  let processingId = $state<string | null>(null);
  let mutedNames = $state<Record<string, string>>({});

  onMount(() => {
    if (!isGlobalAdmin()) {
      void goto('/');
      return;
    }
    void loadReports();
  });

  async function loadReports() {
    loadingReports = true;
    error = '';
    try {
      reports = await listReports();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Impossible de charger les signalements.';
    } finally {
      loadingReports = false;
    }
  }

  async function loadMuted() {
    loadingMuted = true;
    error = '';
    try {
      mutedUsers = await listMutedUsers();
      const names: Record<string, string> = {};
      const ids = [
        ...new Set([
          ...mutedUsers.map((u) => u.userId),
          ...mutedUsers.filter((u) => u.mutedBy).map((u) => u.mutedBy!),
        ]),
      ];
      for (const id of ids) names[id] = getUserDisplayNameSync(id, id);
      mutedNames = names;
      for (const id of ids) {
        void resolveUserDisplayName(id).then((n) => {
          if (n) mutedNames = { ...mutedNames, [id]: n };
        });
      }
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

  async function handleMuteFromReport(report: ContentReport) {
    processingId = report.id;
    try {
      await muteUser(report.reporterId);
      await handleReview(report.id, 'reviewed');
    } catch (e) {
      error = e instanceof Error ? e.message : 'Erreur';
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

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  }

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

  const pendingReports = $derived(reports.filter((r) => r.status === 'pending'));
  const resolvedReports = $derived(reports.filter((r) => r.status !== 'pending'));
</script>

<div class="max-w-3xl mx-auto px-4 py-8">
  <header class="mb-6 flex items-center justify-between gap-3">
    <div class="flex items-center gap-3">
      <ShieldAlert size={28} class="text-red-500" />
      <div>
        <h1 class="text-2xl font-bold text-text-main">Modération</h1>
        <p class="text-sm text-text-muted">Signalements et utilisateurs restreints</p>
      </div>
    </div>
    <button
      onclick={() => (tab === 'reports' ? loadReports() : loadMuted())}
      disabled={loadingReports || loadingMuted}
      class="p-2 rounded-xl border border-cn-border text-text-muted hover:text-text-main transition-colors disabled:opacity-40"
      aria-label="Rafraîchir"
    >
      <RefreshCw size={18} class={loadingReports || loadingMuted ? 'animate-spin' : ''} />
    </button>
  </header>

  <!-- Tabs -->
  <div class="flex gap-1 p-1 bg-black/5 rounded-xl mb-6">
    <button
      onclick={() => switchTab('reports')}
      class="flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-lg transition-colors {tab === 'reports'
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
      onclick={() => switchTab('muted')}
      class="flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-lg transition-colors {tab === 'muted'
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

  <!-- Reports tab -->
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
          En attente — {pendingReports.length}
        </h2>
        <div class="space-y-3 mb-8">
          {#each pendingReports as report (report.id)}
            <div
              class="rounded-2xl border border-cn-border bg-white/70 backdrop-blur-sm p-4 shadow-sm"
            >
              <div class="flex items-start gap-3">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap mb-1">
                    <span
                      class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-cn-border/40 text-text-muted"
                    >
                      {report.contentType}
                    </span>
                    <span class="text-xs text-text-muted">
                      Signalé par <code class="font-mono">{report.reporterId.slice(0, 8)}…</code> · {formatDate(
                        report.createdAt
                      )}
                    </span>
                  </div>
                  <p class="text-sm text-text-main font-medium mb-0.5">
                    Raison : <span class="font-bold">{report.reason}</span>
                  </p>
                  {#if report.details}
                    <p class="text-xs text-text-muted italic mt-1">"{report.details}"</p>
                  {/if}
                  <p class="text-[11px] text-text-muted/60 mt-1 font-mono">
                    ID contenu : {report.contentId}
                  </p>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                  <button
                    onclick={() => handleReview(report.id, 'reviewed')}
                    disabled={processingId === report.id}
                    class="p-1.5 rounded-lg border border-cn-border text-text-muted hover:text-green-600 hover:border-green-400 transition-colors disabled:opacity-40"
                    title="Marquer comme traité"
                  >
                    <Check size={15} />
                  </button>
                  <button
                    onclick={() => handleMuteFromReport(report)}
                    disabled={processingId === report.id}
                    class="p-1.5 rounded-lg border border-cn-border text-text-muted hover:text-red-600 hover:border-red-400 transition-colors disabled:opacity-40"
                    title="Muter le signaleur"
                  >
                    <UserX size={15} />
                  </button>
                  <button
                    onclick={() => handleReview(report.id, 'dismissed')}
                    disabled={processingId === report.id}
                    class="p-1.5 rounded-lg border border-cn-border text-text-muted hover:text-gray-600 hover:border-gray-400 transition-colors disabled:opacity-40"
                    title="Ignorer"
                  >
                    <X size={15} />
                  </button>
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      <!-- Resolved reports -->
      {#if resolvedReports.length > 0}
        <h2 class="text-sm font-bold text-text-muted uppercase tracking-wider mb-3">
          Traités / Ignorés — {resolvedReports.length}
        </h2>
        <div class="space-y-2">
          {#each resolvedReports as report (report.id)}
            <div class="rounded-xl border border-cn-border bg-white/40 p-3 flex items-center gap-3">
              <span
                class="text-[11px] font-bold px-2 py-0.5 rounded-full {statusClass[report.status]}"
              >
                {statusLabel[report.status]}
              </span>
              <span class="text-xs text-text-muted">{report.contentType} · {report.reason}</span>
              <span class="ml-auto text-[11px] text-text-muted/60">{formatDate(report.createdAt)}</span>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  {/if}

  <!-- Muted users tab -->
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
                {mutedNames[user.userId] ?? user.userId}
              </p>
              <p class="text-[11px] font-mono text-text-muted/50">{user.userId.slice(0, 16)}…</p>
              {#if user.mutedReason}
                <p class="text-xs text-text-muted mt-0.5 italic">"{user.mutedReason}"</p>
              {/if}
              {#if user.mutedAt}
                <p class="text-[11px] text-text-muted/60 mt-1">
                  Muté le {formatDate(user.mutedAt)}
                  {#if user.mutedBy}
                    par {mutedNames[user.mutedBy] ?? user.mutedBy.slice(0, 8) + '…'}
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
