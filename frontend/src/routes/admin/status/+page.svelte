<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { RefreshCw, Wifi, WifiOff, TriangleAlert } from 'lucide-svelte';

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
  let intervalId: ReturnType<typeof setInterval>;

  const REFRESH_MS = 5000;

  async function fetchPresence() {
    try {
      const res = await apiFetch('/api/admin/presence');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as PresenceResponse;
      devices = data.devices;
      total = data.total;
      lastUpdated = new Date();
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Erreur inconnue';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void fetchPresence();
    intervalId = setInterval(() => void fetchPresence(), REFRESH_MS);
  });

  onDestroy(() => clearInterval(intervalId));

  function isAnomaly(d: DeviceEntry): boolean {
    return d.wsConnected !== d.redisOnline;
  }

  const anomalies = $derived(devices.filter(isAnomaly));

  function ttlColor(ttl: number): string {
    if (ttl < 0) return 'text-zinc-500';
    if (ttl < 20) return 'text-red-400';
    if (ttl < 50) return 'text-yellow-400';
    return 'text-green-400';
  }

  function fmt(id: string): string {
    return id.length > 20 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
  }
</script>

<svelte:head>
  <title>Admin — Statut des connexions</title>
</svelte:head>

{#snippet deviceTable(rows: DeviceEntry[])}
  {#if rows.length === 0}
    <p class="text-zinc-500 text-xs">Aucun appareil</p>
  {:else}
    <div class="overflow-x-auto rounded-lg border border-zinc-800">
      <table class="w-full text-left text-xs">
        <thead class="bg-zinc-900 text-zinc-400">
          <tr>
            <th class="px-3 py-2">User ID</th>
            <th class="px-3 py-2">Device ID</th>
            <th class="px-3 py-2 text-center">WS</th>
            <th class="px-3 py-2 text-center">Tabs WS</th>
            <th class="px-3 py-2 text-center">Redis</th>
            <th class="px-3 py-2 text-center">TTL (s)</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as d (d.userId + ':' + d.deviceId)}
            <tr
              class="border-t border-zinc-800 {isAnomaly(d)
                ? 'bg-yellow-900/20'
                : 'hover:bg-zinc-800/40'}"
            >
              <td class="px-3 py-2 text-zinc-300" title={d.userId}>{fmt(d.userId)}</td>
              <td class="px-3 py-2 text-zinc-400" title={d.deviceId}>{fmt(d.deviceId)}</td>
              <td class="px-3 py-2 text-center">
                {#if d.wsConnected}
                  <Wifi size={13} class="inline text-green-400" />
                {:else}
                  <WifiOff size={13} class="inline text-zinc-500" />
                {/if}
              </td>
              <td class="px-3 py-2 text-center text-zinc-300">
                {d.wsTabs > 0 ? d.wsTabs : '—'}
              </td>
              <td class="px-3 py-2 text-center">
                {#if d.redisOnline}
                  <span class="text-green-400">✓</span>
                {:else}
                  <span class="text-zinc-500">✗</span>
                {/if}
              </td>
              <td class="px-3 py-2 text-center {ttlColor(d.redisTtl)}">
                {d.redisTtl >= 0 ? d.redisTtl : '—'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/snippet}

<div class="mx-auto max-w-5xl p-6 font-mono text-sm">
  <div class="mb-6 flex items-center justify-between">
    <div>
      <h1 class="text-xl font-bold text-white">Connexions en direct</h1>
      <p class="text-zinc-400">
        {total} appareil{total !== 1 ? 's' : ''} — actualisation toutes les {REFRESH_MS / 1000}s
      </p>
    </div>
    <div class="flex items-center gap-3">
      {#if lastUpdated}
        <span class="text-xs text-zinc-500">MAJ {lastUpdated.toLocaleTimeString()}</span>
      {/if}
      <button
        onclick={() => void fetchPresence()}
        class="flex items-center gap-1.5 rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
      >
        <RefreshCw size={13} />
        Actualiser
      </button>
    </div>
  </div>

  {#if error}
    <div class="mb-4 rounded-md border border-red-800 bg-red-900/30 px-4 py-3 text-red-300">
      {error}
    </div>
  {/if}

  {#if loading}
    <div class="text-zinc-400">Chargement…</div>
  {:else}
    {#if anomalies.length > 0}
      <section class="mb-8">
        <h2 class="mb-2 flex items-center gap-2 font-semibold text-yellow-400">
          <TriangleAlert size={14} />
          Anomalies ({anomalies.length}) — WS et Redis désynchronisés
        </h2>
        <p class="mb-3 text-xs text-zinc-500">
          WS connecté mais Redis absent → présence jamais écrite (bug gateway). Redis présent mais
          WS absent → TTL pas encore expiré après déconnexion.
        </p>
        {@render deviceTable(anomalies)}
      </section>
    {:else if !loading}
      <div class="mb-6 flex items-center gap-2 text-xs text-green-400">
        <Wifi size={13} />
        Aucune anomalie — WS et Redis sont synchronisés
      </div>
    {/if}

    <section>
      <h2 class="mb-2 font-semibold text-zinc-300">Tous les appareils ({total})</h2>
      {@render deviceTable(devices)}
    </section>
  {/if}
</div>
