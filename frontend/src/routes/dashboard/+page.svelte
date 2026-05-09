<script lang="ts">
  import {
    LayoutDashboard,
    MessageCircle,
    Newspaper,
    Users,
    CalendarDays,
    FileText,
    Settings,
    Upload,
    Download,
    ScanLine,
    Smartphone,
    Monitor,
    User,
    Bell,
    Moon,
    Sun,
    LogOut,
  } from 'lucide-svelte';
  import { goto } from '$app/navigation';
  import { clearAuth } from '$lib/stores/auth';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { useSyncSession } from '$lib/composables/useSyncSession.svelte';
  import SyncSessionModal from '$lib/components/chat/SyncSessionModal.svelte';
  import DeviceManagementPanel from '$lib/components/chat/DeviceManagementPanel.svelte';
  import {
    globalSession as session,
    globalConvs as convs,
    appendLog,
  } from '$lib/stores/globalChatSingleton.svelte';

  interface Section {
    label: string;
    description: string;
    href: string;
    icon: 'users' | 'newspaper' | 'message-circle' | 'calendar-days' | 'file-text' | 'settings';
    group: 'principal' | 'outils';
  }

  const sections: Section[] = [
    {
      label: 'Communautés',
      description: "Espaces d'associations et canaux",
      href: '/communities',
      icon: 'users',
      group: 'principal',
    },
    {
      label: 'Feed',
      description: 'Le fil social de la communauté',
      href: '/posts',
      icon: 'newspaper',
      group: 'principal',
    },
    {
      label: 'Discussions',
      description: 'Messages directs et petits groupes',
      href: '/chat',
      icon: 'message-circle',
      group: 'principal',
    },
    {
      label: 'Associations',
      description: 'Les associations de la communauté',
      href: '/associations',
      icon: 'users',
      group: 'outils',
    },
    {
      label: 'Évènements',
      description: 'Calendrier, rendez-vous, évènements',
      href: '/events',
      icon: 'calendar-days',
      group: 'outils',
    },
    {
      label: 'Formulaires',
      description: 'Sondages et inscriptions',
      href: '/forms',
      icon: 'file-text',
      group: 'outils',
    },
    {
      label: "Gestion de l'association",
      description: "Tableau de bord administrateur de l'asso",
      href: '/dashboard/association',
      icon: 'settings',
      group: 'outils',
    },
  ];

  const principal = sections.filter((s) => s.group === 'principal');
  const outils = sections.filter((s) => s.group === 'outils');

  // ─── Sync & Device tools ──────────────────────────────────────────────────
  const sync = useSyncSession();

  let showDevicePanel = $state(false);
  let pendingInvitationCount = $state(0);
  let fileInput: HTMLInputElement | undefined = $state();
  let isDarkMode = $state(false);
  let isPushTestRunning = $state(false);
  let pushTestResult = $state('');
  let isAdmin = $derived(isGlobalAdmin());

  function applyTheme(isDark: boolean) {
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
    localStorage.setItem('canari-theme', isDark ? 'dark' : 'light');
  }

  function toggleTheme() {
    isDarkMode = !isDarkMode;
    applyTheme(isDarkMode);
  }

  async function handleLogout() {
    await clearAuth();
    void goto('/login', { replaceState: true });
  }

  async function handleBroadcastPushTest() {
    if (isPushTestRunning) return;

    isPushTestRunning = true;
    pushTestResult = '';
    try {
      const response = await apiFetch(`${session.historyBaseUrl}/api/mls/push/broadcast-test`, {
        method: 'POST',
        body: JSON.stringify({
          title: 'Canari - test push global',
          message: `Diagnostic ${new Date().toLocaleTimeString()}`,
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${text ? `: ${text}` : ''}`);
      }

      const data = (await response.json()) as {
        traceId: string;
        targetedDevices: number;
        sent: number;
        failed: number;
      };
      pushTestResult = `Test envoye. trace=${data.traceId} devices=${data.targetedDevices} sent=${data.sent} failed=${data.failed}`;
    } catch (error) {
      pushTestResult = `Echec test push: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      isPushTestRunning = false;
    }
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
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('canari-theme');
      isDarkMode = saved === 'dark';
    }
  });

  $effect(() => {
    if (!session.isLoggedIn || !session.myDeviceId) return;
    const userId = session.userId;
    const deviceId = session.myDeviceId;
    let cancelled = false;

    async function pollPendingInvitations() {
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

    void pollPendingInvitations();
    const interval = setInterval(pollPendingInvitations, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
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
        {:else if s.icon === 'file-text'}
          <FileText size={20} class="text-text-muted" />
        {:else if s.icon === 'settings'}
          <Settings size={20} class="text-text-muted" />
        {/if}
      </span>
      <span>
        <span class="block font-semibold text-text-main">{s.label}</span>
        <span class="block text-sm text-text-muted mt-0.5">{s.description}</span>
      </span>
    </a>
  {/snippet}

  <!-- Sections principales -->
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
        onclick={toggleTheme}
        class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))] transition-colors"
        title="Basculer le thème"
      >
        {#if isDarkMode}
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

  <section class="mb-8">
    <h2 class="text-xs font-semibold uppercase tracking-widest text-text-muted mb-3">Principal</h2>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {#each principal as s (s.href)}
        {@render card(s)}
      {/each}
    </div>
  </section>

  <!-- Outils & gestion -->
  <section class="mb-8">
    <h2 class="text-xs font-semibold uppercase tracking-widest text-text-muted mb-3">
      Outils & gestion
    </h2>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {#each outils as s (s.href)}
        {@render card(s)}
      {/each}
    </div>
  </section>

  <!-- Données & synchronisation -->
  <section class="mb-8">
    <h2 class="text-xs font-semibold uppercase tracking-widest text-text-muted mb-3">
      Données & synchronisation
    </h2>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <!-- Import -->
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

      <!-- Export -->
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

      <!-- Démarrer synchronisation QR -->
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

      <!-- Rejoindre synchronisation QR -->
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

      <!-- Gérer les appareils -->
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

      {#if isAdmin}
        <button
          type="button"
          onclick={() => void handleBroadcastPushTest()}
          disabled={isPushTestRunning}
          class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))] transition-colors disabled:opacity-50"
          title="Envoyer un test push global"
        >
          <Bell size={22} class="text-text-muted" />
          <span class="text-sm font-medium text-text-main">
            {isPushTestRunning ? 'Envoi...' : 'Test push'}
          </span>
          <span class="text-xs text-text-muted text-center">Tous les appareils avec token</span>
        </button>
      {/if}
    </div>

    {#if pushTestResult}
      <p class="mt-3 text-sm text-text-muted">{pushTestResult}</p>
    {/if}
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
