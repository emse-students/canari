<script lang="ts">
  import {
    Monitor,
    Smartphone,
    Trash2,
    RefreshCw,
    TriangleAlert,
    Loader,
    ShieldAlert,
    Pen,
    X,
  } from '@lucide/svelte';
  import Modal from '../shared/Modal.svelte';
  import type { IMlsService } from '$lib/mls-client';
  import {
    describeUserAgent,
    fetchAuthSessions,
    revokeAuthSession,
    type AuthSessionInfo,
  } from '$lib/services/authSessions';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { exactDate, timeAgo } from '$lib/utils/time';
  import { m } from '$lib/paraglide/messages';

  interface DeviceInfo {
    deviceId: string;
    keyPackage: Uint8Array;
    deviceName?: string;
    deviceOs?: string;
    deviceAppVersion?: string;
  }

  /**
   * One entry in the list. A device and a login are two records of the same
   * physical thing, held by two services, so a row carries both - joined on the
   * device id the session was stamped with at unlock.
   *
   * Either half can be missing, and each absence means something different:
   *  - sessions empty: an enrolled device holding no live login. It can still
   *    decrypt what it already has, so it is still worth deleting when lost.
   *  - device null: a login that never named a device, or names one the server
   *    no longer lists. That is the shape a stolen cookie takes, so it gets a
   *    row of its own instead of being folded into a device it cannot claim.
   *
   * `sessions` is a list rather than a single value even though `bindDevice`
   * enforces one live login per device: rows opened before that rule existed,
   * and devices that have not unlocked since, are still legitimately plural.
   */
  interface PanelRow {
    key: string;
    device: DeviceInfo | null;
    /** Live logins on this device, most recently used first. */
    sessions: AuthSessionInfo[];
    isCurrentDevice: boolean;
    /**
     * For a device-less row, the device id the login claimed but that the server
     * did not list - null when it claimed none at all. The two are told apart
     * because only the second means "never unlocked MLS".
     */
    unlistedDeviceId: string | null;
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
  let sessions = $state<AuthSessionInfo[]>([]);
  /**
   * Whether the login list is KNOWN. Devices and logins come from two services,
   * so one can answer while the other does not - and a row must then say
   * nothing about connections rather than render "no active connection", which
   * would state as fact something this panel does not know.
   */
  let sessionsKnown = $state(false);
  let loading = $state(false);
  let error = $state('');
  let sessionError = $state('');
  let editingDeviceId = $state<string | null>(null);
  let editingName = $state('');
  /** Key of the row being deleted, so only its own control shows a spinner. */
  let deleting = $state<string | null>(null);

  /**
   * Whether the device we are running on appears in the list the server returned.
   *
   * Every safeguard here is keyed on matching `myDeviceId` against a row: the highlight, the
   * "current device" badge, and the hidden delete button. When no row matches, all three vanish
   * silently and the panel looks like a list of other people's machines - which is how the user
   * ends up deleting every row and landing on "0 devices". The server can legitimately omit us
   * (the list is filtered to the retention window and drops a device whose KeyPackage cannot be
   * resolved), so this is a state to SHOW, not an impossibility to assert.
   */
  const currentDeviceListed = $derived(devices.some((d) => d.deviceId === myDeviceId));

  /**
   * The joined list. Devices first, current one at the top, then whatever
   * activity is most recent; logins with no device close the list because they
   * are the ones the user is being asked to look at hardest.
   */
  const rows = $derived.by((): PanelRow[] => {
    const listedIds = devices.map((d) => d.deviceId);
    const deviceRows: PanelRow[] = devices.map((device) => ({
      key: device.deviceId,
      device,
      sessions: sessions
        .filter((s) => s.deviceId === device.deviceId)
        .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt)),
      isCurrentDevice: device.deviceId === myDeviceId,
      unlistedDeviceId: null,
    }));

    // A login belongs to no row above when it named no device at all, or named
    // one the server did not list. Stated as a predicate over the two lists
    // rather than as a mark left behind by the loop: there is then no order in
    // which the two can disagree.
    const orphanRows: PanelRow[] = sessions
      .filter((s) => s.deviceId === null || !listedIds.includes(s.deviceId))
      .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt))
      .map((s) => ({
        key: `session:${s.id}`,
        device: null,
        sessions: [s],
        isCurrentDevice: false,
        unlistedDeviceId: s.deviceId,
      }));

    deviceRows.sort((a, b) => {
      if (a.isCurrentDevice !== b.isCurrentDevice) return a.isCurrentDevice ? -1 : 1;
      return lastActivity(b) - lastActivity(a);
    });
    return [...deviceRows, ...orphanRows];
  });

  $effect(() => {
    if (open && userId) {
      void loadDeviceData();
    }
  });

  /** Most recent login instant of a row, 0 when it holds none (such rows sort last). */
  function lastActivity(row: PanelRow): number {
    return row.sessions.length > 0 ? Date.parse(row.sessions[0].lastUsedAt) : 0;
  }

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

  /** Whether a row is drawn with a phone icon, from the device or - failing that - its login. */
  function rowIsMobile(row: PanelRow): boolean {
    if (row.device) return isMobileOs(row.device);
    return describeUserAgent(row.sessions[0]?.userAgent ?? null, '').kind === 'mobile';
  }

  /**
   * The browser the most recent login came from, prefixed to the activity line.
   *
   * Empty for a device-less row, whose TITLE is already that same label - the
   * user has to be able to answer "is one of these not me?", and giving them the
   * same answer twice on one row does not help.
   */
  function sessionBrowserLabel(row: PanelRow): string {
    if (!row.device) return '';
    const ua = row.sessions[0]?.userAgent ?? null;
    if (!ua) return '';
    return describeUserAgent(ua, '').label;
  }

  /**
   * Short form of a device id: enough to recognise a row and to match it against
   * a log line, which a position in the list cannot do - the position changes
   * whenever the list does. The full id stays available on hover.
   */
  function shortDeviceId(deviceId: string): string {
    return deviceId.slice(0, 8);
  }

  /**
   * Loads both halves of the list.
   *
   * The two calls hit different services and are awaited together rather than in
   * sequence: a slow login list must not delay the devices, and a failure of
   * either is reported as itself - the panel says which half is missing instead
   * of showing one empty list for two different causes.
   */
  async function loadDeviceData() {
    loading = true;
    error = '';
    sessionError = '';
    try {
      console.log('[DevicePanel] Loading devices and sessions for user:', userId);
      const [deviceResult, sessionResult] = await Promise.allSettled([
        mlsService.fetchUserDevices(userId),
        fetchAuthSessions(),
      ]);

      if (sessionResult.status === 'fulfilled') {
        sessions = sessionResult.value;
        sessionsKnown = true;
        console.log(`[DevicePanel] ${sessions.length} live session(s)`);
      } else {
        sessions = [];
        sessionsKnown = false;
        sessionError = m.settings_sessions_load_error();
        console.error('[DevicePanel] Failed to load sessions', sessionResult.reason);
      }

      if (deviceResult.status === 'rejected') throw deviceResult.reason;
      devices = deviceResult.value;
      console.log(`[DevicePanel] Found ${devices.length} device(s)`);
      // Worth a loud line: this is the state in which every self-protection in this panel is
      // inert, and the cause is server-side (retention filter, unresolvable KeyPackage) so it
      // cannot be diagnosed from what the UI shows.
      if (!devices.some((d) => d.deviceId === myDeviceId)) {
        console.warn(`[DevicePanel] Current device ${myDeviceId} is ABSENT from its own list`);
      }
    } catch (e) {
      console.error('[DevicePanel] Failed to load device data', e);
      error = m.chat_devices_load_error();
    } finally {
      loading = false;
    }
  }

  /** Human-readable label for a device, falling back to its OS when unnamed. */
  function deviceLabel(device: DeviceInfo): string {
    return device.deviceName || getDeviceOsLabel(device);
  }

  /** Title of a row: the device name, or the browser the login came from. */
  function rowLabel(row: PanelRow): string {
    if (row.device) return deviceLabel(row.device);
    return describeUserAgent(
      row.sessions[0]?.userAgent ?? null,
      m.settings_sessions_unknown_device()
    ).label;
  }

  /**
   * Signs a row's logins out. Every session of the row dies: the row IS the
   * device from the user's point of view, so leaving one alive would answer
   * "remove this" with "some of it".
   *
   * Each revocation is its own try - one failing must not abandon the others -
   * and the count of failures is returned so a partial result is reported as
   * partial rather than as success.
   */
  async function revokeRowSessions(row: PanelRow): Promise<number> {
    let failed = 0;
    for (const s of row.sessions) {
      try {
        await revokeAuthSession(s.id);
      } catch (e) {
        failed++;
        console.error(`[DevicePanel] Revoke failed for session ${s.id}`, e);
      }
    }
    return failed;
  }

  /**
   * The single destructive action of this panel: the row goes away, and whoever
   * held it starts over.
   *
   * For a device it is deliberately both halves - the MLS device is revoked AND
   * its logins are signed out - because a user removing a machine they no longer
   * trust means one thing, not two, and shipping two buttons made them do half
   * the job. The device is revoked FIRST: it is the irreversible half, and if a
   * revocation then fails the surviving cookie can only reach the reset path,
   * whereas the reverse order would leave a trusted device behind a completed
   * sign-out. A device with no live login is still deletable, and a login with
   * no device only has the sign-out half to perform.
   */
  async function handleRemoveRow(row: PanelRow) {
    if (row.isCurrentDevice) return;
    // Never empty the account. Deleting the current device is already blocked above, so reaching
    // zero means we did not recognise ourselves in the list - and the deletion would then hit the
    // machine we are on. That is not recoverable by re-logging in: deleteDevice denylists the
    // device against re-registration until it wipes itself back to a fresh install.
    if (row.device && devices.length <= 1) {
      console.warn(`[DevicePanel] Refused to delete the last device ${row.key.slice(0, 8)}…`);
      error = m.chat_device_last_one_error();
      return;
    }

    const confirmed = await showConfirm(
      row.device
        ? m.chat_delete_device_confirm({ name: rowLabel(row) })
        : m.chat_device_revoke_session_confirm(),
      { danger: true, confirmLabel: m.common_delete_button() }
    );
    if (!confirmed) {
      console.log(`[DevicePanel] Removal of ${row.key} cancelled by user`);
      return;
    }

    deleting = row.key;
    try {
      if (row.device) {
        console.log(`[DevicePanel] Deleting device ${shortDeviceId(row.device.deviceId)}…`);
        const result = await mlsService.deleteDevice(userId, row.device.deviceId);
        if (result.status !== 'device_deleted') {
          error = m.chat_device_delete_auth_error();
          return;
        }
        console.log(
          `[DevicePanel] Deleted device ${shortDeviceId(row.device.deviceId)}… (groups cleaned: ${result.groupsCleaned}, keyPackages: ${result.keyPackagesDeleted})`
        );
      }
      const failed = await revokeRowSessions(row);
      if (failed > 0) {
        // The device is gone but a credential for it survived: say so, because the two halves
        // have different consequences and only one of them is visible in the list.
        sessionError = m.settings_sessions_revoke_error();
      } else {
        showToast(
          row.device ? m.chat_device_removed_toast() : m.settings_sessions_revoked_toast(),
          'info'
        );
      }
    } catch (e) {
      console.error('[DevicePanel] Failed to remove row', e);
      error = row.device ? m.chat_device_remove_error() : m.settings_sessions_revoke_error();
    } finally {
      deleting = null;
    }
    await loadDeviceData();
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
</script>

<Modal {open} title={m.chat_device_management_title()} {onClose} maxWidth="max-w-xl">
  <div class="px-1">
    {#if loading}
      <div class="text-text-muted flex flex-col items-center justify-center gap-4 py-12">
        <Loader size={28} class="animate-spin text-amber-500" />
        <span class="text-sm font-semibold tracking-wide">{m.chat_syncing_devices()}</span>
      </div>
    {:else}
      <!-- The error sits ABOVE the list, never instead of it: a refused deletion has to be read
           next to the devices it refused to touch, not on an empty panel. -->
      {#if error}
        <div
          class="mb-4 flex items-start gap-3 rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-600 shadow-inner dark:text-red-400"
        >
          <ShieldAlert size={20} class="mt-0.5 shrink-0" />
          <p class="text-sm leading-relaxed font-medium">{error}</p>
        </div>
      {/if}

      <!-- Separate from `error` on purpose: the logins come from another service, and a row with
           no connection line has to be readable as "not known" rather than "none". -->
      {#if sessionError}
        <div
          class="mb-4 flex items-start gap-3 rounded-2xl border border-orange-500/20 bg-orange-500/10 p-4 text-orange-700 shadow-inner dark:text-orange-300"
        >
          <TriangleAlert size={20} class="mt-0.5 shrink-0" />
          <p class="text-sm leading-relaxed font-medium">{sessionError}</p>
        </div>
      {/if}

      {#if devices.length > 0 && !currentDeviceListed}
        <div
          class="mb-4 flex items-start gap-3 rounded-2xl border border-orange-500/20 bg-orange-500/10 p-4 text-orange-700 shadow-inner dark:text-orange-300"
        >
          <TriangleAlert size={20} class="mt-0.5 shrink-0" />
          <p class="text-sm leading-relaxed font-medium">
            {m.chat_device_not_listed_warning({ id: myDeviceId })}
          </p>
        </div>
      {/if}

      <div class="space-y-5 pb-2">
        <p class="text-text-muted text-sm leading-relaxed">
          {m.chat_devices_intro()}
        </p>

        <p class="text-text-muted text-[0.85rem] font-bold tracking-wider uppercase">
          {m.chat_devices_count_label({ devices: devices.length })}
        </p>

        <div class="space-y-4">
          {#each rows as row (row.key)}
            {@const latest = row.sessions[0]}
            {@const browser = sessionBrowserLabel(row)}

            <div
              class="rounded-3xl border p-4 transition-all duration-300 hover:shadow-md sm:p-5
                {row.isCurrentDevice
                ? 'border-amber-500/30 bg-amber-500/5 shadow-inner'
                : row.device === null
                  ? 'border-orange-500/30 bg-orange-500/5'
                  : 'border-black/5 bg-white/40 backdrop-blur-md dark:border-white/10 dark:bg-black/20'}"
            >
              <div class="flex items-start gap-4 sm:items-center">
                <div
                  class="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl shadow-sm
                  {row.isCurrentDevice
                    ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400'
                    : row.device === null
                      ? 'bg-orange-500/15 text-orange-600 dark:text-orange-400'
                      : 'text-text-muted bg-white/80 dark:bg-white/10'}"
                >
                  {#if row.device === null}
                    <ShieldAlert size={24} strokeWidth={2} />
                  {:else if rowIsMobile(row)}
                    <Smartphone size={24} strokeWidth={2} />
                  {:else}
                    <Monitor size={24} strokeWidth={2} />
                  {/if}
                </div>

                <div class="min-w-0 flex-1 pt-0.5 sm:pt-0">
                  {#if row.device && editingDeviceId === row.device.deviceId}
                    <div class="mb-2 flex items-center gap-2">
                      <input
                        type="text"
                        bind:value={editingName}
                        placeholder={m.chat_device_name_placeholder()}
                        maxlength="80"
                        class="text-text-main placeholder:text-text-muted flex-1 rounded-lg border border-black/10 bg-white/50 px-3 py-1.5 text-sm focus:ring-2 focus:ring-amber-500 focus:outline-none dark:border-white/10 dark:bg-white/10"
                      />
                      <button
                        onclick={() => void saveName()}
                        class="rounded-lg bg-amber-500 px-2.5 py-1.5 text-xs font-bold text-white transition-all hover:bg-amber-600 active:scale-95"
                      >
                        {m.common_ok_button()}
                      </button>
                      <button
                        onclick={cancelEditing}
                        class="text-text-muted rounded-lg p-1.5 transition-all hover:bg-black/5 dark:hover:bg-white/5"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  {:else}
                    <div class="mb-1 flex flex-wrap items-center gap-2">
                      <span class="text-text-main truncate text-[0.95rem] font-bold">
                        {rowLabel(row)}
                      </span>
                      {#if row.device}
                        <span
                          class="text-text-muted rounded-full bg-black/5 px-2 py-0.5 text-[0.65rem] font-semibold tracking-wider uppercase dark:bg-white/10"
                        >
                          {getDeviceOsLabel(row.device)}
                        </span>
                      {/if}
                      {#if row.isCurrentDevice}
                        <span
                          class="text-cn-ink rounded-full bg-amber-500 px-2 py-0.5 text-[0.65rem] font-extrabold tracking-wider uppercase shadow-sm"
                        >
                          {m.chat_current_device_badge()}
                        </span>
                      {/if}
                    </div>

                    <!-- Connection lines, rendered ONLY when the login list answered, so an absent
                         line never has to be read as "no connection". -->
                    {#if sessionsKnown}
                      {#if latest}
                        <p
                          class="text-text-muted text-xs font-medium"
                          title={exactDate(latest.lastUsedAt)}
                        >
                          {#if browser}<span class="font-semibold">{browser}</span> -
                          {/if}{m.settings_sessions_last_used({
                            when: timeAgo(latest.lastUsedAt),
                          })}{#if row.sessions.length > 1}<span class="opacity-70">
                              - {m.chat_device_session_count({ count: row.sessions.length })}</span
                            >{/if}
                        </p>
                        <p class="text-text-muted/70 mt-0.5 text-xs font-medium">
                          {m.settings_sessions_started({ when: exactDate(latest.createdAt) })}
                        </p>
                      {:else}
                        <p class="text-text-muted/70 text-xs font-medium">
                          {m.chat_device_no_session()}
                        </p>
                      {/if}
                    {/if}

                    <div class="mt-1 flex items-center gap-2">
                      <div
                        class="text-text-muted flex-1 truncate font-mono text-[0.7rem] opacity-80"
                        title={row.device?.deviceId ?? row.unlistedDeviceId ?? ''}
                      >
                        {#if row.device}
                          {shortDeviceId(row.device.deviceId)}
                          {#if rowIsMobile(row) && row.device.deviceAppVersion}
                            <span class="ml-2 font-semibold"
                              >{m.chat_device_version_label({
                                device: row.device.deviceAppVersion,
                              })}</span
                            >
                          {/if}
                        {:else if row.unlistedDeviceId}
                          {shortDeviceId(row.unlistedDeviceId)}
                        {/if}
                      </div>
                      {#if row.device}
                        <button
                          onclick={() => row.device && startEditing(row.device.deviceId)}
                          class="text-text-muted rounded-lg p-1.5 transition-all outline-none hover:bg-black/5 hover:text-amber-600 focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:bg-white/5 dark:hover:text-amber-400"
                          title={m.chat_rename_device_title()}
                          aria-label={m.chat_rename_device_label()}
                        >
                          <Pen size={14} strokeWidth={2} />
                        </button>
                      {/if}
                    </div>
                  {/if}
                </div>

                <!-- One destructive control per row, and never on the machine we are running on. -->
                {#if !row.isCurrentDevice}
                  <button
                    onclick={() => void handleRemoveRow(row)}
                    disabled={deleting !== null}
                    class="text-text-muted shrink-0 rounded-xl bg-black/5 p-2.5 transition-all outline-none hover:bg-red-500/15 hover:text-red-600 focus-visible:ring-2 focus-visible:ring-red-500 active:scale-95 disabled:opacity-40 dark:bg-white/5 dark:hover:bg-red-500/20 dark:hover:text-red-400"
                    title={m.chat_delete_device_title()}
                    aria-label={m.chat_delete_device_label()}
                  >
                    {#if deleting === row.key}
                      <Loader size={18} class="animate-spin" />
                    {:else}
                      <Trash2 size={18} strokeWidth={2.5} />
                    {/if}
                  </button>
                {/if}
              </div>

              <!-- A login with no device: say why it is here rather than let it look like a bug. -->
              {#if row.device === null}
                <p
                  class="mt-3 text-xs leading-relaxed font-medium text-orange-700 sm:pl-16 dark:text-orange-300"
                >
                  {row.unlistedDeviceId
                    ? m.chat_device_session_unlisted_note()
                    : m.chat_device_session_orphan_note()}
                </p>
              {/if}
            </div>
          {/each}
        </div>

        {#if rows.length === 0}
          <div
            class="text-text-muted rounded-3xl border border-dashed border-black/10 bg-black/5 py-10 text-center text-sm font-medium dark:border-white/10 dark:bg-white/5"
          >
            {m.chat_no_devices_registered()}
          </div>
        {/if}

        <!-- Stated because it is surprising: an access token already handed out is verified
             without a database round trip, so it keeps working until it expires. Hiding that
             would make the deletion look like it did nothing. -->
        {#if sessionsKnown}
          <p class="text-text-muted/70 text-xs leading-relaxed">
            {m.settings_sessions_delay_note()}
          </p>
        {/if}
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <button
      onclick={loadDeviceData}
      disabled={loading}
      class="text-text-main focus-visible:ring-text-muted inline-flex items-center justify-center gap-2 rounded-xl bg-black/5 px-5 py-2.5 text-sm font-bold transition-all outline-none hover:bg-black/10 focus-visible:ring-2 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white/10 dark:hover:bg-white/20"
    >
      <RefreshCw size={16} strokeWidth={2.5} class={loading ? 'animate-spin' : ''} />
      {m.common_refresh_button()}
    </button>
  {/snippet}
</Modal>
