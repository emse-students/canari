<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { gatewayUrl } from '$lib/utils/apiUrl';
  import { fetchUserProfile, type UserProfile } from '$lib/stores/user';
  import { RefreshCw, Wifi, WifiOff, TriangleAlert, Info } from '@lucide/svelte';
  import { SvelteMap } from 'svelte/reactivity';

  interface DeviceEntry {
    userId: string;
    deviceId: string;
    wsConnected: boolean;
    wsTabs: number;
    redisOnline: boolean;
    redisTtl: number;
  }

  interface PresenceResponse {
    devices: DeviceEntry[];
    total: number;
  }

  let devices = $state<DeviceEntry[]>([]);
  let total = $state(0);
  let lastUpdated = $state<Date | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  const profiles = new SvelteMap<string, UserProfile>();
  let showLegend = $state(false);
  let intervalId: ReturnType<typeof setInterval>;

  const REFRESH_MS = 5000;

  async function fetchPresence() {
    try {
      const res = await apiFetch(`${gatewayUrl()}/api/admin/presence`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as PresenceResponse;
      devices = data.devices;
      total = data.total;
      lastUpdated = new Date();
      error = null;

      // Fetch profiles for any new userIds
      const known = profiles;
      const newIds = [...new Set(data.devices.map((d) => d.userId))].filter(
        (id) => !known.has(id)
      );
      for (const id of newIds) {
        fetchUserProfile(id)
          .then((p) => {
            profiles.set(id, p);
          })
          .catch(() => {});
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Erreur inconnue';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    if (!isGlobalAdmin()) {
      void goto('/admin', { replaceState: true });
      return;
    }
    void fetchPresence();
    intervalId = setInterval(() => void fetchPresence(), REFRESH_MS);
  });

  onDestroy(() => clearInterval(intervalId));

  function isAnomaly(d: DeviceEntry): boolean {
    return d.wsConnected !== d.redisOnline;
  }

  const anomalies = $derived(devices.filter(isAnomaly));

  function ttlClass(ttl: number): string {
    if (ttl < 0) return 'text-text-muted';
    if (ttl < 5) return 'text-red-err font-semibold';
    if (ttl < 10) return 'text-cn-yellow';
    return 'text-green-ok';
  }

  function displayName(userId: string): string {
    const p = profiles.get(userId);
    if (!p) return '…';
    const parts = [p.firstName, p.lastName].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : (p.displayName ?? p.email ?? userId.slice(0, 12));
  }

  function shortId(id: string): string {
    return id.length > 12 ? `${id.slice(0, 8)}…` : id;
  }
</script>

<svelte:head>
  <title>Admin — Statut des connexions</title>
</svelte:head>

{#snippet deviceTable(rows: DeviceEntry[])}
  {#if rows.length === 0}
    <p class="text-sm text-text-muted">Aucun appareil.</p>
  {:else}
    <div class="overflow-x-auto rounded-xl border border-cn-border">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-cn-border bg-[var(--surface-elevated)] text-xs font-semibold uppercase tracking-wide text-text-muted">
            <th class="px-4 py-2.5 text-left">Utilisateur</th>
            <th class="px-4 py-2.5 text-left">Device ID</th>
            <th class="px-4 py-2.5 text-center">WS</th>
            <th class="px-4 py-2.5 text-center">Onglets</th>
            <th class="px-4 py-2.5 text-center">Redis</th>
            <th class="px-4 py-2.5 text-center">TTL (s)</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as d (d.userId + ':' + d.deviceId)}
            <tr
              class="border-b border-cn-border last:border-0 transition-colors
                {isAnomaly(d)
                ? 'bg-[color-mix(in_srgb,var(--cn-yellow)_6%,var(--cn-surface))]'
                : 'bg-[var(--cn-surface)] hover:bg-[var(--surface-elevated)]'}"
            >
              <td class="px-4 py-3">
                <span class="block font-medium text-text-main">{displayName(d.userId)}</span>
                <span class="block text-xs text-text-muted font-mono" title={d.userId}
                  >{shortId(d.userId)}</span
                >
              </td>
              <td class="px-4 py-3 font-mono text-xs text-text-muted" title={d.deviceId}>
                {shortId(d.deviceId)}
              </td>
              <td class="px-4 py-3 text-center">
                {#if d.wsConnected}
                  <span class="inline-flex items-center gap-1 text-green-ok font-medium">
                    <Wifi size={14} />
                    <span class="text-xs">Connecté</span>
                  </span>
                {:else}
                  <span class="inline-flex items-center gap-1 text-text-muted">
                    <WifiOff size={14} />
                    <span class="text-xs">–</span>
                  </span>
                {/if}
              </td>
              <td class="px-4 py-3 text-center text-text-muted">
                {d.wsTabs > 0 ? d.wsTabs : '–'}
              </td>
              <td class="px-4 py-3 text-center">
                {#if d.redisOnline}
                  <span class="text-green-ok font-semibold">✓</span>
                {:else}
                  <span class="text-text-muted">–</span>
                {/if}
              </td>
              <td class="px-4 py-3 text-center font-mono {ttlClass(d.redisTtl)}">
                {d.redisTtl >= 0 ? d.redisTtl : '–'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/snippet}

<div class="mx-auto max-w-5xl p-6">
  <!-- En-tête -->
  <div class="mb-6 flex flex-wrap items-start justify-between gap-3">
    <div>
      <h1 class="text-2xl font-bold text-text-main">Connexions en direct</h1>
      <p class="mt-0.5 text-text-muted">
        {total} appareil{total !== 1 ? 's' : ''} — rafraîchissement toutes les {REFRESH_MS /
          1000}s
      </p>
    </div>
    <div class="flex items-center gap-2">
      {#if lastUpdated}
        <span class="text-xs text-text-muted">MAJ {lastUpdated.toLocaleTimeString()}</span>
      {/if}
      <button
        onclick={() => (showLegend = !showLegend)}
        class="flex items-center gap-1.5 rounded-lg border border-cn-border bg-[var(--cn-surface)] px-3 py-1.5 text-sm text-text-muted hover:border-cn-yellow hover:text-text-main transition-colors"
      >
        <Info size={14} />
        Légende
      </button>
      <button
        onclick={() => void fetchPresence()}
        class="flex items-center gap-1.5 rounded-lg border border-cn-border bg-[var(--cn-surface)] px-3 py-1.5 text-sm text-text-muted hover:border-cn-yellow hover:text-text-main transition-colors"
      >
        <RefreshCw size={14} />
        Actualiser
      </button>
    </div>
  </div>

  <!-- Légende -->
  {#if showLegend}
    <div class="mb-6 rounded-xl border border-cn-border bg-[var(--cn-surface)] p-5 text-sm">
      <h2 class="mb-4 font-semibold text-text-main">Comment interpréter ce tableau</h2>
      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <p class="mb-1 font-medium text-text-main">
            <Wifi size={13} class="mr-1 inline text-green-ok" />WS (WebSocket)
          </p>
          <p class="text-text-muted">
            Connexion WebSocket active en mémoire du gateway. Chaque onglet ouvert dans l'app
            compte comme un onglet (colonne "Onglets"). Après un <strong class="text-text-main"
              >arrêt forcé</strong
            > de l'app, le serveur envoie un Ping toutes les 30s : s'il ne reçoit pas de Pong, il
            ferme la connexion. L'utilisateur reste marqué "WS connecté" pendant
            <strong class="text-text-main">jusqu'à ~30s</strong> après la déconnexion.
          </p>
        </div>
        <div>
          <p class="mb-1 font-medium text-text-main">Redis (présence)</p>
          <p class="text-text-muted">
            Clé <code class="rounded bg-[var(--surface-elevated)] px-1 font-mono text-xs"
              >user:online:&#123;userId&#125;:&#123;deviceId&#125;</code
            >
            dans Redis. Créée à la connexion WS, rafraîchie à chaque Pong. Supprimée automatiquement
            quand la connexion se ferme proprement.
          </p>
        </div>
        <div>
          <p class="mb-1 font-medium text-text-main">TTL (secondes restantes)</p>
          <p class="text-text-muted">
            Durée de vie restante de la clé Redis. La clé expire après 90s sans refresh.
            <span class="text-green-ok font-medium">Vert</span> = sain,
            <span class="text-cn-yellow font-medium">jaune</span> = bientôt expiré,
            <span class="text-red-err font-medium">rouge</span> = &lt;20s (connexion probablement
            morte).
          </p>
        </div>
        <div>
          <p class="mb-1 font-medium text-text-main">
            <TriangleAlert size={13} class="mr-1 inline text-cn-yellow" />Anomalies (fond jaune)
          </p>
          <p class="text-text-muted">
            <strong class="text-text-main">Redis ✓ mais WS –</strong> : connexion fermée (ex. arrêt forcé
            de l'app) mais la clé Redis n'a pas encore expiré. Disparaîtra en ≤30s.<br />
            <strong class="text-text-main">WS ✓ mais Redis –</strong> : connexion active mais présence
            jamais écrite (bug gateway) ou TTL expiré sans refresh.
          </p>
        </div>
      </div>
    </div>
  {/if}

  {#if error}
    <div
      class="mb-4 rounded-xl border border-red-err/30 bg-[color-mix(in_srgb,var(--red-err)_8%,var(--cn-surface))] px-4 py-3 text-sm text-red-err"
    >
      {error}
    </div>
  {/if}

  {#if loading}
    <div class="text-text-muted">Chargement…</div>
  {:else}
    <!-- Anomalies -->
    {#if anomalies.length > 0}
      <section class="mb-8">
        <h2 class="mb-1 flex items-center gap-2 font-semibold text-text-main">
          <TriangleAlert size={16} class="text-cn-yellow" />
          {anomalies.length} anomalie{anomalies.length > 1 ? 's' : ''} — WS et Redis désynchronisés
        </h2>
        <p class="mb-3 text-sm text-text-muted">
          Fond jaune = WS et Redis ne sont pas d'accord sur le statut de l'appareil.
        </p>
        {@render deviceTable(anomalies)}
      </section>
    {:else}
      <div class="mb-6 flex items-center gap-2 rounded-xl border border-cn-border bg-[var(--cn-surface)] px-4 py-3 text-sm text-green-ok">
        <Wifi size={14} />
        Aucune anomalie — WS et Redis sont synchronisés sur tous les appareils
      </div>
    {/if}

    <!-- Tous les appareils -->
    <section>
      <h2 class="mb-3 text-xs font-semibold uppercase tracking-widest text-text-muted">
        Tous les appareils ({total})
      </h2>
      {@render deviceTable(devices)}
    </section>
  {/if}
</div>
