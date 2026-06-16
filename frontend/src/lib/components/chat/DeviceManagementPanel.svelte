<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import {
    Monitor,
    Smartphone,
    Trash2,
    RefreshCw,
    TriangleAlert,
    CheckCircle,
    Clock,
    Loader,
    ShieldAlert,
    Edit2,
    X,
  } from '@lucide/svelte';
  import Modal from '../shared/Modal.svelte';
  import type { IMlsService } from '$lib/mls-client';
  import { m } from '$lib/paraglide/messages';

  interface DeviceMembership {
    id: string;
    userId: string;
    deviceId: string;
    groupId: string;
    status: string;
  }

  interface DeviceInfo {
    deviceId: string;
    keyPackage: Uint8Array;
    deviceName?: string;
    deviceOs?: string;
    deviceAppVersion?: string;
  }

  interface Props {
    /** Whether the modal is visible. */
    open: boolean;
    /** ID of the user whose devices are being managed. */
    userId: string;
    /** Device ID of the current device, used to highlight and protect it from deletion. */
    myDeviceId: string;
    /** MLS service instance used to fetch and manage device data. */
    mlsService: IMlsService;
    /** Callback to close the modal. */
    onClose: () => void;
  }

  let { open, userId, myDeviceId, mlsService, onClose }: Props = $props();

  let devices = $state<DeviceInfo[]>([]);
  let memberships = new SvelteMap<string, DeviceMembership[]>();
  let loading = $state(false);
  let error = $state('');
  let editingDeviceId = $state<string | null>(null);
  let editingName = $state('');

  $effect(() => {
    if (open && userId) {
      void loadDeviceData();
    }
  });

  function getDeviceOsLabel(device: DeviceInfo): string {
    const os = (device.deviceOs || '').toLowerCase();
    if (os === 'windows') return 'Windows';
    if (os === 'macos') return 'macOS';
    if (os === 'linux') return 'Linux';
    if (os === 'android') return 'Android';
    if (os === 'ios') return 'iOS';
    if (os === 'desktop') return 'Desktop';
    if (os === 'web') return m.chat_device_os_browser();
    if (device.deviceId.startsWith('tauri-')) return 'Desktop (Tauri)';
    if (device.deviceId.startsWith('web-')) return m.chat_device_os_browser();
    if (device.deviceId.startsWith('mobile-')) return 'Mobile';
    return m.chat_device_os_unknown();
  }

  function isMobileOs(device: DeviceInfo): boolean {
    const os = (device.deviceOs || '').toLowerCase();
    return os === 'android' || os === 'ios';
  }

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
      error = m.chat_devices_load_error();
    } finally {
      loading = false;
    }
  }

  async function handleRemoveDevice(deviceId: string) {
    if (deviceId === myDeviceId) return;
    console.log(`[DevicePanel] Deleting device ${deviceId.slice(0, 8)}…`);
    try {
      const result = await mlsService.deleteDevice(userId, deviceId);
      if (result.status !== 'device_deleted') {
        error = m.chat_device_delete_auth_error();
        return;
      }
      console.log(
        `[DevicePanel] Deleted device ${deviceId.slice(0, 8)}… (groups cleaned: ${result.groupsCleaned}, keyPackages: ${result.keyPackagesDeleted})`
      );
      await loadDeviceData();
    } catch (e) {
      console.error('[DevicePanel] Failed to delete device', e);
      error = m.chat_device_remove_error();
    }
  }

  function startEditing(deviceId: string) {
    editingDeviceId = deviceId;
    const device = devices.find((d) => d.deviceId === deviceId);
    editingName = device?.deviceName ?? '';
  }

  function cancelEditing() {
    editingDeviceId = null;
    editingName = '';
  }

  async function saveName() {
    if (!editingDeviceId) return;
    try {
      await mlsService.updateDeviceMetadata(userId, editingDeviceId, {
        deviceName: editingName.trim(),
      });
      editingDeviceId = null;
      editingName = '';
      await loadDeviceData();
    } catch (e) {
      console.error('[DevicePanel] Failed to rename device', e);
      error = m.chat_device_rename_error();
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
    const inProgress = deviceMemberships.filter((m) => m.status === 'welcome_sent').length;
    return { total, active, pending, inProgress };
  }
</script>

<Modal {open} title={m.chat_device_management_title()} {onClose} maxWidth="max-w-xl">
  <div class="px-1">
    {#if loading}
      <div class="flex flex-col items-center justify-center py-12 gap-4 text-text-muted">
        <Loader size={28} class="animate-spin text-amber-500" />
        <span class="text-sm font-semibold tracking-wide">{m.chat_syncing_devices()}</span>
      </div>
    {:else if error}
      <div
        class="flex items-start gap-3 p-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 mb-4 shadow-inner"
      >
        <ShieldAlert size={20} class="shrink-0 mt-0.5" />
        <p class="text-sm font-medium leading-relaxed">{error}</p>
      </div>
    {:else}
      <div class="space-y-5 pb-2">
        <div class="flex items-center justify-between">
          <p class="text-[0.85rem] font-bold uppercase tracking-wider text-text-muted">
            {m.chat_devices_count_label({ devices: devices.length })}
          </p>
        </div>

        <div class="space-y-4">
          {#each devices as device (device.deviceId)}
            {@const isCurrentDevice = device.deviceId === myDeviceId}
            {@const deviceMemberships = memberships.get(device.deviceId) ?? []}
            {@const stats = getMembershipStats(deviceMemberships)}
            {@const staleGroups = getStaleGroups(deviceMemberships)}

            <div
              class="rounded-[1.5rem] border p-4 sm:p-5 space-y-4 transition-all duration-300 hover:shadow-md
                {isCurrentDevice
                ? 'border-amber-500/30 bg-amber-500/5 shadow-inner'
                : 'border-black/5 dark:border-white/10 bg-white/40 dark:bg-black/20 backdrop-blur-md'}"
            >
              <!-- En-tête de l'appareil -->
              <div class="flex items-start sm:items-center gap-4">
                <div
                  class="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 shadow-sm
                  {isCurrentDevice
                    ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400'
                    : 'bg-white/80 dark:bg-white/10 text-text-muted'}"
                >
                  {#if isMobileOs(device)}
                    <Smartphone size={24} strokeWidth={2} />
                  {:else}
                    <Monitor size={24} strokeWidth={2} />
                  {/if}
                </div>

                <div class="flex-1 min-w-0 pt-0.5 sm:pt-0">
                  {#if editingDeviceId === device.deviceId}
                    <div class="flex gap-2 items-center mb-2">
                      <input
                        type="text"
                        bind:value={editingName}
                        placeholder={m.chat_device_name_placeholder()}
                        maxlength="80"
                        class="flex-1 px-3 py-1.5 rounded-lg text-sm bg-white/50 dark:bg-white/10 border border-black/10 dark:border-white/10 text-text-main placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-amber-500"
                      />
                      <button
                        onclick={() => void saveName()}
                        class="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-amber-500 text-white hover:bg-amber-600 transition-all active:scale-95"
                      >
                        {m.common_ok_button()}
                      </button>
                      <button
                        onclick={cancelEditing}
                        class="p-1.5 rounded-lg text-text-muted hover:bg-black/5 dark:hover:bg-white/5 transition-all"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  {:else}
                    <div class="flex flex-wrap items-center gap-2 mb-1">
                      <span class="font-bold text-[0.95rem] text-text-main truncate">
                        {device.deviceName || getDeviceOsLabel(device)}
                      </span>
                      <span
                        class="text-[0.65rem] px-2 py-0.5 rounded-full bg-black/5 dark:bg-white/10 font-semibold text-text-muted uppercase tracking-wider"
                      >
                        {getDeviceOsLabel(device)}
                      </span>
                      {#if isCurrentDevice}
                        <span
                          class="text-[0.65rem] px-2 py-0.5 rounded-full bg-amber-500 text-[#151B2C] font-extrabold uppercase tracking-wider shadow-sm"
                        >
                          {m.chat_current_device_badge()}
                        </span>
                      {/if}
                    </div>
                    <div class="flex items-center gap-2">
                      <div
                        class="text-[0.7rem] font-mono text-text-muted opacity-80 truncate flex-1"
                        title={device.deviceId}
                      >
                        {m.chat_device_id_label({ device: device.deviceId.slice(0, 24) })}
                        {#if isMobileOs(device) && device.deviceAppVersion}
                          <span class="ml-2 font-semibold">{m.chat_device_version_label({ device: device.deviceAppVersion ?? '' })}</span>
                        {/if}
                      </div>
                      <button
                        onclick={() => startEditing(device.deviceId)}
                        class="p-1.5 rounded-lg text-text-muted hover:text-amber-600 dark:hover:text-amber-400 hover:bg-black/5 dark:hover:bg-white/5 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                        title={m.chat_rename_device_title()}
                        aria-label={m.chat_rename_device_label()}
                      >
                        <Edit2 size={14} strokeWidth={2} />
                      </button>
                    </div>
                  {/if}
                </div>

                {#if !isCurrentDevice}
                  <button
                    onclick={() => handleRemoveDevice(device.deviceId)}
                    class="p-2.5 rounded-xl bg-black/5 dark:bg-white/5 hover:bg-red-500/15 dark:hover:bg-red-500/20 text-text-muted hover:text-red-600 dark:hover:text-red-400 transition-all outline-none focus-visible:ring-2 focus-visible:ring-red-500 active:scale-95 shrink-0"
                    title={m.chat_delete_device_title()}
                    aria-label={m.chat_delete_device_label()}
                  >
                    <Trash2 size={18} strokeWidth={2.5} />
                  </button>
                {/if}
              </div>

              <!-- Statistiques d'adhésions (Pills) -->
              <div class="flex flex-wrap items-center gap-2 text-xs sm:pl-16">
                {#if stats.active > 0}
                  <span
                    class="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1.5 rounded-xl font-medium"
                  >
                    <CheckCircle size={14} />
                    {m.chat_device_active_count({ stats: stats.active })}
                  </span>
                {/if}
                {#if stats.pending > 0}
                  <span
                    class="flex items-center gap-1.5 text-orange-600 dark:text-orange-400 bg-orange-500/10 border border-orange-500/20 px-2.5 py-1.5 rounded-xl font-medium"
                  >
                    <Clock size={14} />
                    {m.chat_device_pending_count({ stats: stats.pending })}
                  </span>
                {/if}
                {#if stats.inProgress > 0}
                  <span
                    class="flex items-center gap-1.5 text-blue-600 dark:text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2.5 py-1.5 rounded-xl font-medium"
                  >
                    <Loader size={14} class="animate-spin" />
                    {m.chat_device_in_progress_count({ stats: stats.inProgress })}
                  </span>
                {/if}
                {#if stats.total === 0}
                  <span class="text-text-muted/70 italic px-1 font-medium"
                    >{m.chat_no_synced_groups()}</span
                  >
                {/if}
              </div>

              <!-- Alerte de groupes obsolètes / en attente -->
              {#if staleGroups.length > 0 && !isCurrentDevice}
                <div
                  class="flex items-start gap-3 p-3.5 rounded-xl bg-orange-500/10 border border-orange-500/20 sm:ml-16 mt-2"
                >
                  <TriangleAlert size={18} class="text-orange-500 mt-0.5 shrink-0" />
                  <p class="text-xs text-orange-700 dark:text-orange-300 leading-relaxed font-medium">
                    {m.chat_device_stale_groups_warning({ staleGroups: staleGroups.length })}
                  </p>
                </div>
              {/if}
            </div>
          {/each}
        </div>

        {#if devices.length === 0}
          <div
            class="text-center py-10 text-text-muted text-sm font-medium border border-dashed border-black/10 dark:border-white/10 rounded-[1.5rem] bg-black/5 dark:bg-white/5"
          >
            {m.chat_no_devices_registered()}
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <button
      onclick={loadDeviceData}
      disabled={loading}
      class="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-text-main bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-text-muted"
    >
      <RefreshCw size={16} strokeWidth={2.5} class={loading ? 'animate-spin' : ''} />
      {m.common_refresh_button()}
    </button>
  {/snippet}
</Modal>
