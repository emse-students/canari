<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
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
  import {
    buildPanelRows,
    removeDeviceRow,
    revocableDeviceId,
    type PanelRow as PanelRowOf,
  } from './deviceRowRemoval';
  import {
    createDevicePanelLoader,
    panelStateFrom,
    settleRemoval,
    type PanelLoadResult,
  } from './devicePanelLoad';

  interface DeviceInfo {
    deviceId: string;
    deviceName?: string;
    deviceOs?: string;
    deviceAppVersion?: string;
  }

  /**
   * One entry in the list (`buildPanelRows`). A device and a login are two records of the same
   * physical thing, held by two services, so a row carries both - joined on the device id the
   * session was stamped with at unlock. Either half can be missing: no login means an enrolled
   * device holding no live login (still worth deleting when lost); no device means a login that
   * never named one, or names one the server no longer lists - the shape a stolen cookie takes, so
   * it gets a row of its own.
   */
  type PanelRow = PanelRowOf<DeviceInfo, AuthSessionInfo>;

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
  /**
   * Whether the device list is KNOWN on this load. False until the last fetch answered, and after a
   * failed one: a login "not in the list" read off a list that did not load is every healthy device,
   * and such a row revokes what it names - one delete would wipe the user's phone.
   */
  let devicesKnown = $state(false);
  let loading = $state(false);
  let error = $state('');
  let sessionError = $state('');
  let editingDeviceId = $state<string | null>(null);
  let editingName = $state('');
  /** Key of the row being deleted, so only its own control shows a spinner. */
  let deleting = $state<string | null>(null);

  /** The panel's loads: only the latest one writes (`devicePanelLoad.ts`). */
  const loader = createDevicePanelLoader<DeviceInfo, AuthSessionInfo>({
    listDevices: () => mlsService.listUserDevices(userId),
    fetchSessions: fetchAuthSessions,
    apply: applyLoad,
  });

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
  const rows = $derived(buildPanelRows({ devices, devicesKnown, sessions, myDeviceId }));

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
   * Loads both halves of the list.
   *
   * The two calls hit different services and are awaited together rather than in
   * sequence: a slow login list must not delay the devices, and a failure of
   * either is reported as itself - the panel says which half is missing instead
   * of showing one empty list for two different causes.
   */
  async function loadDeviceData() {
    loading = true;
    // Unknown from the moment a load starts: rows built meanwhile name no unlisted device.
    devicesKnown = false;
    error = '';
    sessionError = '';
    console.log('[DevicePanel] Loading devices and sessions for user:', userId);
    await loader.load();
  }

  /**
   * Writes the latest load's answer - every field of it, so nothing of an earlier load survives
   * (`panelStateFrom`). A superseded load never reaches here (`createDevicePanelLoader`).
   */
  function applyLoad(result: PanelLoadResult<DeviceInfo, AuthSessionInfo>) {
    const state = panelStateFrom(result);
    devices = state.devices;
    devicesKnown = state.devicesKnown;
    sessions = state.sessions;
    sessionsKnown = state.sessionsKnown;
    loading = false;
    if (result.sessions.status === 'rejected') {
      sessionError = m.settings_sessions_load_error();
      console.error('[DevicePanel] Failed to load sessions', result.sessions.reason);
    } else {
      console.log(`[DevicePanel] ${sessions.length} live session(s)`);
    }
    if (result.devices.status === 'rejected') {
      error = m.chat_devices_load_error();
      console.error('[DevicePanel] Failed to load device data', result.devices.reason);
      return;
    }
    console.log(`[DevicePanel] Found ${devices.length} device(s)`);
    // Worth a loud line: this is the state in which every self-protection in this panel is
    // inert, and the cause is server-side (retention filter, unresolvable KeyPackage) so it
    // cannot be diagnosed from what the UI shows.
    if (!devices.some((d) => d.deviceId === myDeviceId)) {
      console.warn(`[DevicePanel] Current device ${myDeviceId} is ABSENT from its own list`);
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
   * The single destructive action of this panel: the row goes away, and whoever
   * held it starts over.
   *
   * For a device it is deliberately both halves - the MLS device is revoked AND
   * its logins are signed out - because a user removing a machine they no longer
   * trust means one thing, not two, and shipping two buttons made them do half
   * the job. The device is revoked FIRST: it is the irreversible half, and if a
   * revocation then fails the surviving cookie can only reach the reset path.
   * The sign-out half runs EVEN WHEN the device half answered an error
   * (`removeDeviceRow`): the logins it ends are the ones the server may not have
   * ended, and what survives stays listed for the user's retry. A device with no
   * live login is still deletable, and a login with no device only has the
   * sign-out half to perform - unless that login names a device the server no longer lists, which
   * is revoked as a device is (`revocableDeviceId`).
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

    // A login row that names an unlisted device revokes that device too (`revocableDeviceId`), so
    // its confirmation says the machine is erased, exactly as a listed device's does.
    const revokes = revocableDeviceId(row, { myDeviceId, devicesKnown }) !== null;
    const confirmed = await showConfirm(
      revokes
        ? m.chat_delete_device_confirm({ name: rowLabel(row) })
        : m.chat_device_revoke_session_confirm(),
      { danger: true, confirmLabel: m.common_delete_button() }
    );
    if (!confirmed) {
      console.log(`[DevicePanel] Removal of ${row.key} cancelled by user`);
      return;
    }

    deleting = row.key;
    // What the removal has to say is shown AFTER the reload, which clears the messages (`settleRemoval`).
    await settleRemoval({
      remove: async () => {
        try {
          const { outcome } = await removeDeviceRow(row, {
            deleteDevice: (deviceId) => mlsService.deleteDevice(userId, deviceId),
            revokeSession: revokeAuthSession,
            myDeviceId,
            devicesKnown,
          });
          if (outcome === 'own-device') {
            // The server refused to ban the device this session is bound to; nothing was signed out.
            return { failure: m.chat_device_remove_own_refused(), sessionFailure: '' };
          }
          if (outcome === 'device-incomplete') {
            // The removal did not complete; whatever is left is still listed after the reload.
            return { failure: m.chat_device_delete_retry_error(), sessionFailure: '' };
          }
          if (outcome === 'sessions-left') {
            // The device is gone but a credential for it survived: say so, because the two halves
            // have different consequences and only one of them is visible in the list.
            return { failure: '', sessionFailure: m.settings_sessions_revoke_error() };
          }
          showToast(
            revokes ? m.chat_device_removed_toast() : m.settings_sessions_revoked_toast(),
            'info'
          );
          return { failure: '', sessionFailure: '' };
        } catch (e) {
          console.error('[DevicePanel] Failed to remove row', e);
          const failure = revokes
            ? m.chat_device_remove_error()
            : m.settings_sessions_revoke_error();
          return { failure, sessionFailure: '' };
        } finally {
          deleting = null;
        }
      },
      reload: loadDeviceData,
      show: ({ failure, sessionFailure }) => {
        if (failure) error = failure;
        if (sessionFailure) sessionError = sessionFailure;
      },
    });
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
        <Loader size={28} class="text-accent-icon animate-spin" />
        <span class="text-sm font-semibold">{m.chat_syncing_devices()}</span>
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
            {m.chat_device_not_listed_warning()}
          </p>
        </div>
      {/if}

      <div class="space-y-5 pb-2">
        <p class="text-text-muted text-sm leading-relaxed">
          {m.chat_devices_intro()}
        </p>

        <p class="text-text-muted text-xs font-bold">
          {m.chat_devices_count_label({ devices: devices.length })}
        </p>

        <div class="space-y-4">
          {#each rows as row (row.key)}
            {@const latest = row.sessions[0]}
            {@const browser = sessionBrowserLabel(row)}

            <!-- `data-device-id`: the rig's hook for the row (purge-devices.mjs); no visible effect, absent
                 on a login-only row, which holds no device. -->
            <div
              data-device-id={row.device?.deviceId}
              class="rounded-3xl border p-4 transition-all duration-300 hover:shadow-md sm:p-5 {row.isCurrentDevice
                ? 'border-accent/30 bg-accent/5 shadow-inner'
                : row.device === null
                  ? 'border-orange-500/30 bg-orange-500/5'
                  : 'bg-cn-surface border-black/5 dark:border-white/10 '}"
            >
              <div class="flex items-start gap-4 sm:items-center">
                <div
                  class="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl shadow-sm {row.isCurrentDevice
                    ? 'bg-accent/20 text-accent-text'
                    : row.device === null
                      ? 'bg-orange-500/15 text-orange-600 dark:text-orange-400'
                      : 'text-text-muted bg-cn-surface '}"
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
                        class="text-text-main placeholder:text-text-muted bg-cn-surface focus:ring-accent-icon flex-1 rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:ring-2 focus:outline-none dark:border-white/10"
                      />
                      <Button onclick={() => void saveName()}>
                        {m.common_ok_button()}
                      </Button>
                      <button
                        onclick={cancelEditing}
                        class="ui-icon-button text-text-muted rounded-lg transition-all hover:bg-black/5 dark:hover:bg-white/5"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  {:else}
                    <div class="mb-1 flex flex-wrap items-center gap-2">
                      <span class="text-text-main truncate text-sm font-bold">
                        {rowLabel(row)}
                      </span>
                      {#if row.device}
                        <span
                          class="text-text-muted text-2xs rounded-full bg-black/5 px-2 py-0.5 font-semibold dark:bg-white/10"
                        >
                          {getDeviceOsLabel(row.device)}
                        </span>
                      {/if}
                      {#if row.isCurrentDevice}
                        <span
                          class="text-on-accent text-2xs bg-accent rounded-full px-2 py-0.5 font-bold shadow-sm"
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

                    {#if row.device && rowIsMobile(row) && row.device.deviceAppVersion}
                      <p class="text-text-muted text-2xs mt-1 font-semibold opacity-80">
                        {m.chat_device_version_label({ device: row.device.deviceAppVersion })}
                      </p>
                    {/if}
                  {/if}
                </div>

                <!--
                  BOTH ROW ACTIONS IN ONE CLUSTER, because matching their appearance while leaving
                  them in different places would only move the question. The pencil used to sit
                  inside the text block, on the line with the device id, while the trash was a
                  sibling of the whole row - so even once they looked alike, one was an action and
                  the other looked like an annotation of the id beside it.
                  Only ONE of them is destructive, which is the whole of what may differ: the box
                  is `ui-icon-button` for both, the hover colour is not. The resting fill and the
                  corner are utilities here because the class stopped declaring them - it owns the
                  box for every icon button in the app now, and a resting grey is this row's idea,
                  not every row's.
                -->
                <div class="flex shrink-0 items-center gap-1.5">
                  {#if row.device}
                    <button
                      onclick={() => row.device && startEditing(row.device.deviceId)}
                      class="ui-icon-button bg-cn-border/50 text-text-muted hover:bg-accent/15 hover:text-accent-text focus-visible:ring-accent-icon rounded-xl focus-visible:ring-2"
                      title={m.chat_rename_device_title()}
                      aria-label={m.chat_rename_device_label()}
                    >
                      <Pen size={18} strokeWidth={2} />
                    </button>
                  {/if}

                  <!-- One destructive control per row, and never on the machine we are running on. -->
                  {#if !row.isCurrentDevice}
                    <button
                      onclick={() => void handleRemoveRow(row)}
                      disabled={deleting !== null}
                      class="ui-icon-button bg-cn-border/50 text-text-muted rounded-xl hover:bg-red-500/15 hover:text-red-600 focus-visible:ring-2 focus-visible:ring-red-500 dark:hover:bg-red-500/20 dark:hover:text-red-400"
                      title={m.chat_delete_device_title()}
                      aria-label={m.chat_delete_device_label()}
                    >
                      {#if deleting === row.key}
                        <Loader size={18} class="animate-spin" />
                      {:else}
                        <Trash2 size={18} strokeWidth={2} />
                      {/if}
                    </button>
                  {/if}
                </div>
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
