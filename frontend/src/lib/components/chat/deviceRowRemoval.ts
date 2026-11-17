/**
 * The device panel's one destructive action, apart from the component so its ORDER and its
 * outcomes can be asserted without rendering it.
 *
 * Both halves always run: the MLS device is revoked (`DELETE /mls/devices/...`, which bans the id,
 * signals the device and ends the logins bound to it server-side), THEN every login the panel shows
 * for the row is signed out. The second half runs even when the first answered an error - a 503
 * means the ban was written but the server could not end the bound logins yet, and those are
 * exactly the logins this panel can end itself. Whatever survives stays listed (a login whose device
 * is no longer listed gets its own row), so the user's retry is always reachable.
 *
 * A login row with no listed device is still a MACHINE when its login names a device id: the server
 * stops listing a device whose KeyPackage aged out or cannot be resolved, and the machine keeps its
 * whole local store. Signing that login out alone is what let an old PC come back under its own id
 * with everything it held (measured on production, 2026-08-22) - so the id it names is revoked too,
 * which wipes the machine at its next exchange. The one id never revoked is the one this panel runs on.
 */

/** A panel row, reduced to what removing it needs. */
export interface RemovableRow {
  device: { deviceId: string } | null;
  /** For a device-less row, the device id its login names but the server does not list. */
  unlistedDeviceId: string | null;
  sessions: ReadonlyArray<{ id: string; current: boolean }>;
}

/** A login, reduced to what joining it to a device needs. */
export interface PanelSession {
  id: string;
  deviceId: string | null;
  current: boolean;
  lastUsedAt: string;
}

/** One entry of the panel: a device and its logins, or a login no listed device claims. */
export interface PanelRow<D extends { deviceId: string }, S extends PanelSession> {
  key: string;
  device: D | null;
  /** Live logins on this device, most recently used first. */
  sessions: S[];
  isCurrentDevice: boolean;
  /**
   * For a device-less row, the device id the login claimed but that the server did not list - null
   * when it claimed none, AND whenever the device list is not known: "not listed" read off a list
   * that failed to load is every healthy device, and that row revokes what it names.
   */
  unlistedDeviceId: string | null;
}

/**
 * Joins the devices and the logins into the panel's rows: devices first (the current one at the
 * top, then by last activity), then the logins no listed device claims.
 *
 * While `devicesKnown` is false (the device list has not answered, or its last load failed) no
 * device row is built, even from a list still held from an earlier open, and no login is said to name
 * an unlisted device - every login is then a plain sign-out row.
 */
export function buildPanelRows<D extends { deviceId: string }, S extends PanelSession>(input: {
  devices: readonly D[];
  devicesKnown: boolean;
  sessions: readonly S[];
  myDeviceId: string;
}): PanelRow<D, S>[] {
  const { devicesKnown, sessions, myDeviceId } = input;
  const devices = devicesKnown ? input.devices : [];
  const byRecency = (a: S, b: S) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt);
  const lastActivity = (row: PanelRow<D, S>) =>
    row.sessions.length > 0 ? Date.parse(row.sessions[0].lastUsedAt) : 0;
  const listedIds = devices.map((d) => d.deviceId);
  const deviceRows: PanelRow<D, S>[] = devices.map((device) => ({
    key: device.deviceId,
    device,
    sessions: sessions.filter((s) => s.deviceId === device.deviceId).sort(byRecency),
    isCurrentDevice: device.deviceId === myDeviceId,
    unlistedDeviceId: null,
  }));
  // A login belongs to no row above when it named no device at all, or named one the server did
  // not list. Stated as a predicate over the two lists rather than as a mark left behind by the
  // loop: there is then no order in which the two can disagree.
  const orphanRows: PanelRow<D, S>[] = sessions
    .filter((s) => s.deviceId === null || !listedIds.includes(s.deviceId))
    .sort(byRecency)
    .map((s) => ({
      key: `session:${s.id}`,
      device: null,
      sessions: [s],
      isCurrentDevice: false,
      unlistedDeviceId: devicesKnown ? s.deviceId : null,
    }));
  deviceRows.sort((a, b) => {
    if (a.isCurrentDevice !== b.isCurrentDevice) return a.isCurrentDevice ? -1 : 1;
    return lastActivity(b) - lastActivity(a);
  });
  return [...deviceRows, ...orphanRows];
}

/**
 * - `removed`: the device (if any) is revoked and every login of the row is signed out.
 * - `sessions-left`: the device half succeeded, but at least one login could not be signed out.
 * - `device-incomplete`: the device revocation did not answer success; the logins were still tried.
 * - `own-device`: the server refused to ban the device the caller's own session is bound to; no
 *   login was signed out, since one of them is the caller's.
 */
export type RowRemovalOutcome = 'removed' | 'sessions-left' | 'device-incomplete' | 'own-device';

/** What decides whether a row revokes a device: the device we run on, and whether the list answered. */
export interface RevocationContext {
  /** The device this panel runs on: never revoked from here, listed or not. */
  myDeviceId: string;
  /** Whether the device list answered on this load; nothing is revoked while it has not. */
  devicesKnown: boolean;
}

export interface RowRemovalDeps extends RevocationContext {
  deleteDevice: (deviceId: string) => Promise<{ status: string }>;
  revokeSession: (sessionId: string) => Promise<unknown>;
}

/**
 * The device id removing this row revokes, or null when the row only signs logins out.
 *
 * Null while the device list is not known. A row holding the current login never revokes: its
 * device is the one we run on, whatever id the server bound it to (a binding left stale by an
 * identity rotation included). Otherwise a listed device is revoked as itself, and a device-less row
 * revokes the id its login names unless that id is ours - the server may omit the device we run on
 * from its list, and banning it would wipe the machine the user is holding. The server refuses the
 * same ban on its own side (`OWN_DEVICE`), from the binding of the calling session.
 */
export function revocableDeviceId(row: RemovableRow, ctx: RevocationContext): string | null {
  if (!ctx.devicesKnown) return null;
  if (row.sessions.some((s) => s.current)) return null;
  if (row.device) return row.device.deviceId;
  if (row.unlistedDeviceId === null || row.unlistedDeviceId === ctx.myDeviceId) return null;
  return row.unlistedDeviceId;
}

/** Removes a row - see the module comment for the order and why the second half always runs. */
export async function removeDeviceRow(
  row: RemovableRow,
  deps: RowRemovalDeps
): Promise<{ outcome: RowRemovalOutcome; failedSessions: number }> {
  let deviceOk = true;
  const deviceId = revocableDeviceId(row, deps);
  if (!deviceId && (row.device || row.unlistedDeviceId !== null)) {
    console.log(
      `[DevicePanel] Row names a device but revokes none (devicesKnown=${deps.devicesKnown}, holds current login=${row.sessions.some((s) => s.current)}) - signing out only`
    );
  }
  if (deviceId) {
    const short = deviceId.slice(0, 8);
    console.log(
      `[DevicePanel] Deleting device ${short}…${row.device ? '' : ' (named by a login, not listed by the server)'}`
    );
    const result = await deps.deleteDevice(deviceId);
    if (result.status === 'own_device') {
      // The server read the calling session's binding and found this very device: every login of
      // the row may include ours, so none is signed out.
      console.error(
        `[DevicePanel] Device ${short}… is the one this session is bound to - the server refused the ban, no login signed out`
      );
      return { outcome: 'own-device', failedSessions: 0 };
    }
    deviceOk = result.status === 'device_deleted';
    if (deviceOk) console.log(`[DevicePanel] Deleted device ${short}…`);
    else
      console.error(
        `[DevicePanel] Device ${short}… revocation answered status=${result.status} - signing its logins out anyway, the user is asked to retry`
      );
  }
  let failedSessions = 0;
  for (const s of row.sessions) {
    try {
      await deps.revokeSession(s.id);
    } catch (e) {
      failedSessions++;
      console.error(`[DevicePanel] Revoke failed for session ${s.id}`, e);
    }
  }
  const outcome: RowRemovalOutcome = !deviceOk
    ? 'device-incomplete'
    : failedSessions > 0
      ? 'sessions-left'
      : 'removed';
  return { outcome, failedSessions };
}
