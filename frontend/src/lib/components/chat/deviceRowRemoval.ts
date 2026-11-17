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

/**
 * - `removed`: the device (if any) is revoked and every login of the row is signed out.
 * - `sessions-left`: the device half succeeded, but at least one login could not be signed out.
 * - `device-incomplete`: the device revocation did not answer success; the logins were still tried.
 */
export type RowRemovalOutcome = 'removed' | 'sessions-left' | 'device-incomplete';

export interface RowRemovalDeps {
  deleteDevice: (deviceId: string) => Promise<{ status: string }>;
  revokeSession: (sessionId: string) => Promise<unknown>;
  /** The device this panel runs on: never revoked from here, listed or not. */
  myDeviceId: string;
}

/**
 * The device id removing this row revokes, or null when the row only signs logins out.
 *
 * A listed device is revoked as itself. A device-less row revokes the id its login names, unless that
 * id is this panel's own device or the row holds the current login - the server may omit the device
 * we run on from its list, and banning it would wipe the machine the user is holding.
 */
export function revocableDeviceId(row: RemovableRow, myDeviceId: string): string | null {
  if (row.device) return row.device.deviceId;
  if (row.unlistedDeviceId === null) return null;
  if (row.unlistedDeviceId === myDeviceId || row.sessions.some((s) => s.current)) return null;
  return row.unlistedDeviceId;
}

/** Removes a row - see the module comment for the order and why the second half always runs. */
export async function removeDeviceRow(
  row: RemovableRow,
  deps: RowRemovalDeps
): Promise<{ outcome: RowRemovalOutcome; failedSessions: number }> {
  let deviceOk = true;
  const deviceId = revocableDeviceId(row, deps.myDeviceId);
  if (!deviceId && row.unlistedDeviceId !== null) {
    console.log(
      `[DevicePanel] Login row names this device (${row.unlistedDeviceId.slice(0, 8)}…) - signing out only, the device we run on is never revoked from here`
    );
  }
  if (deviceId) {
    const short = deviceId.slice(0, 8);
    console.log(
      `[DevicePanel] Deleting device ${short}…${row.device ? '' : ' (named by a login, not listed by the server)'}`
    );
    const result = await deps.deleteDevice(deviceId);
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
