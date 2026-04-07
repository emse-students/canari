<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import {
    Monitor,
    Smartphone,
    Trash2,
    RefreshCw,
    AlertTriangle,
    CheckCircle,
    Clock,
    Loader,
  } from 'lucide-svelte';
  import Modal from '../shared/Modal.svelte';
  import type { IMlsService } from '$lib/services/IMlsService';

  interface DeviceMembership {
    id: string;
    userId: string;
    deviceId: string;
    groupId: string;
    status: string;
    lastEpochSeen: number;
  }

  interface DeviceInfo {
    deviceId: string;
    keyPackage: Uint8Array;
  }

  interface Props {
    open: boolean;
    userId: string;
    myDeviceId: string;
    mlsService: IMlsService;
    onClose: () => void;
  }

  let { open, userId, myDeviceId, mlsService, onClose }: Props = $props();

  let devices = $state<DeviceInfo[]>([]);
  let memberships = new SvelteMap<string, DeviceMembership[]>();
  let loading = $state(false);
  let error = $state('');

  $effect(() => {
    if (open && userId) {
      void loadDeviceData();
    }
  });

  async function loadDeviceData() {
    loading = true;
    error = '';
    try {
      console.log('[DevicePanel] Loading devices for user:', userId);
      const allDevices = await mlsService.fetchUserDevices(userId);
      devices = allDevices;
      console.log(`[DevicePanel] Found ${allDevices.length} device(s)`);

      // Load memberships for each device
      const newMemberships = new SvelteMap<string, DeviceMembership[]>();
      for (const device of allDevices) {
        try {
          const m = await mlsService.getDeviceMemberships(userId, device.deviceId);
          newMemberships.set(device.deviceId, m);
          console.log(
            `[DevicePanel] Device ${device.deviceId.slice(0, 8)}… has ${m.length} membership(s)`
          );
        } catch {
          newMemberships.set(device.deviceId, []);
        }
      }
      memberships.clear();
      for (const [k, v] of newMemberships) {
        memberships.set(k, v);
      }
    } catch (e) {
      console.error('[DevicePanel] Failed to load device data', e);
      error = 'Impossible de charger les appareils.';
    } finally {
      loading = false;
    }
  }

  async function handleRemoveDevice(deviceId: string) {
    if (deviceId === myDeviceId) return;
    console.log(`[DevicePanel] Removing all memberships for device ${deviceId.slice(0, 8)}…`);
    try {
      const result = await mlsService.deleteAllDeviceMemberships(userId, deviceId);
      console.log(
        `[DevicePanel] Deleted ${result.affected} membership(s) for device ${deviceId.slice(0, 8)}…`
      );
      await loadDeviceData();
    } catch (e) {
      console.error('[DevicePanel] Failed to remove device memberships', e);
      error = 'Impossible de supprimer les adhésions de cet appareil.';
    }
  }

  function _statusLabel(status: string) {
    switch (status) {
      case 'welcome_received':
        return 'ok';
      case 'welcome_sent':
        return 'sent';
      case 'pending':
        return 'pending';
      default:
        return 'unknown';
    }
  }

  function getStaleGroups(deviceMemberships: DeviceMembership[]): DeviceMembership[] {
    return deviceMemberships.filter((m) => m.status === 'pending');
  }

  function getMembershipStats(deviceMemberships: DeviceMembership[]) {
    const total = deviceMemberships.length;
    const active = deviceMemberships.filter((m) => m.status === 'welcome_received').length;
    const pending = deviceMemberships.filter((m) => m.status === 'pending').length;
    const inProgress = deviceMemberships.filter(
      (m) => m.status === 'welcome_sent'
    ).length;
    return { total, active, pending, inProgress };
  }
</script>

<Modal {open} title="Gestion des appareils" {onClose} maxWidth="max-w-lg">
  {#if loading}
    <div class="flex items-center justify-center py-8 gap-2 text-text-muted">
      <Loader size={18} class="animate-spin" />
      Chargement...
    </div>
  {:else if error}
    <div class="flex items-center gap-2 text-red-500 py-4">
      <AlertTriangle size={16} />
      {error}
    </div>
  {:else}
    <div class="space-y-4">
      <p class="text-sm text-text-muted">
        {devices.length} appareil{devices.length > 1 ? 's' : ''} enregistré{devices.length > 1
          ? 's'
          : ''}
      </p>

      {#each devices as device (device.deviceId)}
        {@const isCurrentDevice = device.deviceId === myDeviceId}
        {@const deviceMemberships = memberships.get(device.deviceId) ?? []}
        {@const stats = getMembershipStats(deviceMemberships)}
        {@const staleGroups = getStaleGroups(deviceMemberships)}

        <div
          class="rounded-xl border p-3 space-y-2 transition-colors
              {isCurrentDevice
            ? 'border-blue-300 dark:border-blue-700 bg-blue-50/50 dark:bg-blue-900/20'
            : 'border-cn-border bg-[var(--cn-surface)]'}"
        >
          <!-- Device header -->
          <div class="flex items-center gap-3">
            <div class="p-2 rounded-lg bg-white/50 dark:bg-black/20">
              {#if isCurrentDevice}
                <Monitor size={18} class="text-blue-500" />
              {:else}
                <Smartphone size={18} class="text-text-muted" />
              {/if}
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-medium text-sm text-cn-dark truncate">
                  {device.deviceId.slice(0, 12)}…
                </span>
                {#if isCurrentDevice}
                  <span
                    class="text-xs px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-800/40 text-blue-600 dark:text-blue-300 font-medium"
                  >
                    Cet appareil
                  </span>
                {/if}
              </div>
              <div class="text-xs text-text-muted mt-0.5">
                ID: {device.deviceId.slice(0, 20)}…
              </div>
            </div>
            {#if !isCurrentDevice}
              <button
                onclick={() => handleRemoveDevice(device.deviceId)}
                class="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 text-text-muted hover:text-red-500 transition-colors"
                title="Supprimer les adhésions de cet appareil"
                aria-label="Supprimer les adhésions de cet appareil"
              >
                <Trash2 size={14} />
              </button>
            {/if}
          </div>

          <!-- Membership stats -->
          <div class="flex items-center gap-3 text-xs pl-11">
            {#if stats.active > 0}
              <span class="flex items-center gap-1 text-green-500">
                <CheckCircle size={12} />
                {stats.active} actif{stats.active > 1 ? 's' : ''}
              </span>
            {/if}
            {#if stats.pending > 0}
              <span class="flex items-center gap-1 text-orange-400">
                <Clock size={12} />
                {stats.pending} en attente
              </span>
            {/if}
            {#if stats.inProgress > 0}
              <span class="flex items-center gap-1 text-blue-400">
                <Loader size={12} />
                {stats.inProgress} en cours
              </span>
            {/if}
            {#if stats.total === 0}
              <span class="text-text-muted">Aucun groupe</span>
            {/if}
          </div>

          <!-- Stale alert -->
          {#if staleGroups.length > 0 && !isCurrentDevice}
            <div
              class="flex items-start gap-2 p-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 ml-11"
            >
              <AlertTriangle size={14} class="text-amber-500 mt-0.5 shrink-0" />
              <div class="text-xs text-amber-700 dark:text-amber-300">
                {staleGroups.length} groupe{staleGroups.length > 1 ? 's' : ''} en attente de synchronisation.
                L'appareil se synchronisera automatiquement à la prochaine connexion.
              </div>
            </div>
          {/if}
        </div>
      {/each}

      {#if devices.length === 0}
        <div class="text-center py-6 text-text-muted text-sm">Aucun appareil enregistré</div>
      {/if}
    </div>
  {/if}
  {#snippet footer()}
    <button
      onclick={loadDeviceData}
      disabled={loading}
      class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-text-main bg-white/60 dark:bg-black/30 border border-cn-border hover:bg-white/80 dark:hover:bg-black/45 transition-colors disabled:opacity-50"
    >
      <RefreshCw size={14} class={loading ? 'animate-spin' : ''} />
      Rafraîchir
    </button>
  {/snippet}
</Modal>
