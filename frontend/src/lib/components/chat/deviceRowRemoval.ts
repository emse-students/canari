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
 */

/** A panel row, reduced to what removing it needs. */
export interface RemovableRow {
  device: { deviceId: string } | null;
  sessions: ReadonlyArray<{ id: string }>;
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
}

/** Removes a row - see the module comment for the order and why the second half always runs. */
export async function removeDeviceRow(
  row: RemovableRow,
  deps: RowRemovalDeps
): Promise<{ outcome: RowRemovalOutcome; failedSessions: number }> {
  let deviceOk = true;
  if (row.device) {
    const short = row.device.deviceId.slice(0, 8);
    console.log(`[DevicePanel] Deleting device ${short}…`);
    const result = await deps.deleteDevice(row.device.deviceId);
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
