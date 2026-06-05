<script lang="ts">
  import { onMount } from 'svelte';
  import {
    LayoutDashboard,
    MessageCircle,
    Newspaper,
    Users,
    CalendarDays,
    ShoppingBag,
    FileText,
    Upload,
    Download,
    ScanLine,
    Smartphone,
    Monitor,
    User,
    Moon,
    Sun,
    LogOut,
    ShieldAlert,
    Activity,
    UserCog,
    Shield,
  } from '@lucide/svelte';
  import { goto } from '$app/navigation';
  import { clearAuth } from '$lib/stores/auth';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { listMyAssociations } from '$lib/associations/api';
  import { useSyncSession } from '$lib/composables/useSyncSession.svelte';
  import SyncSessionModal from '$lib/components/chat/SyncSessionModal.svelte';
  import DeviceManagementPanel from '$lib/components/chat/DeviceManagementPanel.svelte';
  import {
    globalSession as session,
    globalConvs as convs,
    appendLog,
  } from '$lib/stores/globalChatSingleton.svelte';
  import { createPausableInterval } from '$lib/utils/backgroundPausableInterval';
  import { themeStore } from '$lib/stores/themeStore.svelte';

  interface Section {
    label: string;
    description: string;
    href: string;
    icon:
      | 'users'
      | 'newspaper'
      | 'message-circle'
      | 'calendar-days'
      | 'shopping-bag'
      | 'file-text'
      | 'shield';
  }

  /** Items accessible depuis la nav desktop mais absents de la nav mobile. */
  const exploreItems: Section[] = [
    {
      label: 'Agenda',
      description: 'Événements et calendrier',
      href: '/calendar',
      icon: 'calendar-days',
    },
    {
      label: 'Boutique',
      description: 'Produits et cotisations',
      href: '/shop',
      icon: 'shopping-bag',
    },
    {
      label: 'Associations',
      description: 'Les associations de la communauté',
      href: '/associations',
      icon: 'users',
    },
    {
      label: 'Formulaires',
      description: 'Sondages et inscriptions',
      href: '/forms',
      icon: 'file-text',
    },
  ];

  let showAdminSection = $state(false);

  onMount(async () => {
    if (isGlobalAdmin()) {
      showAdminSection = true;
      return;
    }
    try {
      const mine = await listMyAssociations();
      showAdminSection = mine.some((a) => a.isAdmin);
    } catch {
      showAdminSection = false;
    }
  });

  // ─── Sync & Device tools ──────────────────────────────────────────────────
  const sync = useSyncSession();

  let showDevicePanel = $state(false);
  let pendingInvitationCount = $state(0);
  let fileInput: HTMLInputElement | undefined = $state();
  let isAdmin = $derived(isGlobalAdmin());

  async function handleLogout() {
    await clearAuth();
    void goto('/login', { replaceState: true });
  }

  function syncCtx() {
    return {
      historyBaseUrl: session.historyBaseUrl,
      userId: session.userId,
      myDeviceId: session.myDeviceId,
      pin: session.pin,
      storage: session.storage,
      log: appendLog,
      loadExistingConversations: async () => {},
      processDeviceInvitationsLocally: async () => {},
    };
  }

  function triggerImport() {
    fileInput?.click();
  }

  function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      session.handleImport(
        file,
        appendLog,
        () => convs.conversations.clear(),
        async () => {}
      );
      input.value = '';
    }
  }

  $effect(() => {
    if (!session.isLoggedIn || !session.myDeviceId) return;
    const userId = session.userId;
    const deviceId = session.myDeviceId;
    let cancelled = false;

    async function pollPendingInvitations() {
      if (cancelled) return;
      try {
        const mls = session.ensureMls();
        const memberships = await mls.getDeviceMemberships(userId, deviceId);
        if (!cancelled) {
          pendingInvitationCount = memberships.filter((m) => m.status === 'pending').length;
        }
      } catch {
        // MLS not ready yet
      }
    }

    const cleanup = createPausableInterval(() => void pollPendingInvitations(), 30_000);
    return () => {
      cancelled = true;
      cleanup();
    };
  });
</script>

<div class="p-6 max-w-4xl mx-auto">
  <div class="mb-8">
    <h1 class="text-2xl font-bold text-text-main flex items-center gap-3">
      <LayoutDashboard size={28} class="text-cn-yellow" />
      Tableau de bord
    </h1>
    <p class="text-text-muted mt-1">Vue d'ensemble de l'application</p>
  </div>

  {#snippet card(s: Section)}
    <a
      href={s.href}
      class="group flex items-start gap-4 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))] transition-colors"
    >
      <span
        class="flex-shrink-0 p-2.5 rounded-xl border border-cn-border bg-[var(--surface-elevated)] group-hover:border-cn-yellow transition-colors"
      >
        {#if s.icon === 'users'}
          <Users size={20} class="text-text-muted" />
        {:else if s.icon === 'newspaper'}
          <Newspaper size={20} class="text-text-muted" />
        {:else if s.icon === 'message-circle'}
          <MessageCircle size={20} class="text-text-muted" />
        {:else if s.icon === 'calendar-days'}
          <CalendarDays size={20} class="text-text-muted" />
        {:else if s.icon === 'shopping-bag'}
          <ShoppingBag size={20} class="text-text-muted" />
        {:else if s.icon === 'file-text'}
          <FileText size={20} class="text-text-muted" />
        {:else if s.icon === 'shield'}
          <Shield size={20} class="text-text-muted" />
        {/if}
      </span>
      <span>
        <span class="block font-semibold text-text-main">{s.label}</span>
        <span class="block text-sm text-text-muted mt-0.5">{s.description}</span>
      </span>
    </a>
  {/snippet}

  <!-- Compte (mobile uniquement) -->
  <section class="mb-8 md:hidden">
    <h2 class="text-xs font-semibold uppercase tracking-widest text-text-muted mb-3">Compte</h2>
    <div class="grid grid-cols-3 gap-3">
      <button
        type="button"
        onclick={() => goto('/profile')}
        class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))] transition-colors"
        title="Accéder à votre profil"
      >
        <User size={22} class="text-text-muted" />
        <span class="text-sm font-medium text-text-main">Profil</span>
      </button>

      <button
        type="button"
        onclick={() => themeStore.toggle()}
        class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))] transition-colors"
        title="Basculer le thème"
      >
        {#if themeStore.isDark}
          <Sun size={22} class="text-text-muted" />
        {:else}
          <Moon size={22} class="text-text-muted" />
        {/if}
        <span class="text-sm font-medium text-text-main">Thème</span>
      </button>

      <button
        type="button"
        onclick={handleLogout}
        class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-red-400/40 bg-red-500/5 text-red-600 hover:bg-red-500/10 transition-colors"
        title="Se déconnecter"
      >
        <LogOut size={22} />
        <span class="text-sm font-medium">Déconnexion</span>
      </button>
    </div>
  </section>

  <!-- Explorer (Agenda, Boutique, Associations, Formulaires) -->
  <section class="mb-8">
    <h2 class="text-xs font-semibold uppercase tracking-widest text-text-muted mb-3">Explorer</h2>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {#each exploreItems as s (s.href)}
        {@render card(s)}
      {/each}
    </div>
  </section>

  <!-- Administration (admins d'association et admins globaux) -->
  {#if showAdminSection || isAdmin}
    <section class="mb-8">
      <h2 class="text-xs font-semibold uppercase tracking-widest text-text-muted mb-3">
        Administration
      </h2>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {#if showAdminSection && !isAdmin}
          <!-- Accès générique /admin pour les admins d'association non globaux -->
          <a
            href="/admin"
            class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))] transition-colors"
            title="Administration"
          >
            <Shield size={22} class="text-text-muted" />
            <span class="text-sm font-medium text-text-main">Administration</span>
            <span class="text-xs text-text-muted text-center">Modération agenda, présence</span>
          </a>
        {/if}

        {#if isAdmin}
          <a
            href="/admin/moderation"
            class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-red-400 hover:bg-red-50/40 transition-colors"
            title="Modération"
          >
            <ShieldAlert size={22} class="text-red-500" />
            <span class="text-sm font-medium text-text-main">Modération</span>
            <span class="text-xs text-text-muted text-center">Posts signalés</span>
          </a>
          <a
            href="/admin/status"
            class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))] transition-colors"
            title="Statut système"
          >
            <Activity size={22} class="text-text-muted" />
            <span class="text-sm font-medium text-text-main">Statut</span>
            <span class="text-xs text-text-muted text-center">Présence et appareils</span>
          </a>
          <a
            href="/admin/users"
            class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-amber-400 hover:bg-amber-50/40 dark:hover:bg-amber-900/10 transition-colors"
            title="Gestion des admins"
          >
            <UserCog size={22} class="text-amber-500" />
            <span class="text-sm font-medium text-text-main">Admins</span>
            <span class="text-xs text-text-muted text-center">Droits d'administration</span>
          </a>
        {/if}
      </div>
    </section>
  {/if}

  <!-- Appareils & données -->
  <section class="mb-8">
    <h2 class="text-xs font-semibold uppercase tracking-widest text-text-muted mb-3">
      Appareils & données
    </h2>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <button
        type="button"
        onclick={triggerImport}
        disabled={session.isImporting}
        class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))] transition-colors disabled:opacity-50"
        title="Importer une sauvegarde (.canari)"
      >
        <Upload size={22} class="text-text-muted" />
        <span class="text-sm font-medium text-text-main">Importer</span>
        <span class="text-xs text-text-muted text-center">Restaurer une sauvegarde</span>
      </button>

      <button
        type="button"
        onclick={() => session.handleExport(appendLog)}
        disabled={session.isExporting}
        class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))] transition-colors disabled:opacity-50"
        title="Exporter les conversations"
      >
        <Download size={22} class="text-text-muted" />
        <span class="text-sm font-medium text-text-main">Exporter</span>
        <span class="text-xs text-text-muted text-center">Sauvegarder les conversations</span>
      </button>

      <button
        type="button"
        onclick={() => sync.handleStartSyncSession(syncCtx())}
        disabled={sync.isSyncSessionBusy}
        class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))] transition-colors disabled:opacity-50"
        title="Démarrer une synchronisation QR"
      >
        <ScanLine size={22} class="text-text-muted" />
        <span class="text-sm font-medium text-text-main">Transférer</span>
        <span class="text-xs text-text-muted text-center">Afficher le QR de transfert</span>
      </button>

      <button
        type="button"
        onclick={() => sync.openJoinSyncModal()}
        disabled={sync.isSyncSessionBusy}
        class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))] transition-colors disabled:opacity-50"
        title="Rejoindre une synchronisation QR"
      >
        <Smartphone size={22} class="text-text-muted" />
        <span class="text-sm font-medium text-text-main">Scanner</span>
        <span class="text-xs text-text-muted text-center">Scanner le QR d'un autre appareil</span>
      </button>

      <button
        type="button"
        onclick={() => (showDevicePanel = true)}
        class="relative flex flex-col items-center gap-2 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))] transition-colors"
        title="Gérer les appareils"
      >
        <span class="relative">
          <Monitor size={22} class="text-text-muted" />
          {#if pendingInvitationCount > 0}
            <span
              class="absolute -top-1 -right-1 min-w-[16px] h-[16px] rounded-full bg-orange-500 text-white text-[10px] font-bold flex items-center justify-center px-1"
            >
              {pendingInvitationCount > 99 ? '99+' : pendingInvitationCount}
            </span>
          {/if}
        </span>
        <span class="text-sm font-medium text-text-main">Appareils</span>
        <span class="text-xs text-text-muted text-center">Gérer les appareils connectés</span>
      </button>
    </div>
  </section>
</div>

<input
  bind:this={fileInput}
  type="file"
  accept=".canari"
  class="hidden"
  onchange={handleFileChange}
/>

<SyncSessionModal
  isOpen={sync.isSyncSessionOpen}
  mode={sync.syncMode}
  qrPayload={sync.syncQrPayloadText}
  qrDataUrl={sync.syncQrDataUrl}
  joinPayload={sync.syncJoinPayload}
  statusText={sync.syncStatusText}
  isBusy={sync.isSyncSessionBusy}
  onJoinPayloadChange={(value: string) => (sync.syncJoinPayload = value)}
  onConfirmJoin={() => sync.handleConfirmJoinSync(syncCtx())}
  onCopyPayload={sync.copySyncPayload}
  onClose={sync.closeModal}
/>

{#if session.isLoggedIn}
  <DeviceManagementPanel
    open={showDevicePanel}
    userId={session.userId}
    myDeviceId={session.myDeviceId}
    mlsService={session.ensureMls()}
    onClose={() => (showDevicePanel = false)}
  />
{/if}
