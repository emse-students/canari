/**
 * The devices a staged commit ADDS to the tree, as the `admits` its submission carries.
 *
 * WHY THE SERVER IS TOLD (user, 2026-09-28). A device added while its phone was dead stays
 * `pending` until its own join says otherwise, and a replay at activation (DF2) used to re-send it
 * what a five-minute window still held. That replay is deleted: the server records each admitted
 * device at the epoch the commit creates, IN THE SAME TRANSACTION as the advance, and queues it
 * every frame sealed from then on - so nothing it can open is sent without it being a recipient.
 * Only the committer knows which devices its Add put in the tree, so it says.
 *
 * READ FROM WHAT EVERY ADD CALLER ALREADY PASSES. Each `addMember` / `addMembersBulk` caller
 * excludes from the commit's fan-out exactly the devices it adds - they join by Welcome and cannot
 * process the commit - as `userId:deviceId`. When the staging reports which devices it really added
 * (`addedDeviceIds`), a device it SKIPPED for an invalid KeyPackage is dropped: no Welcome will ever
 * reach it, and queueing it frames would push it ciphertext it can never open. The committing device
 * itself is never admitted.
 *
 * @param excludeDeviceIds - the commit's fan-out exclusions, `userId:deviceId` each.
 * @param addedDeviceIds - the device ids the staging added, when it reports them.
 * @param self - the committing device, as `userId:deviceId`.
 */
export function commitAdmits(
  excludeDeviceIds: string[] | undefined,
  addedDeviceIds: string[] | undefined,
  self: string
): Array<{ userId: string; deviceId: string }> {
  const admits: Array<{ userId: string; deviceId: string }> = [];
  for (const entry of excludeDeviceIds ?? []) {
    if (entry === self) continue;
    // A device id never holds ':' (`web-`, `tauri-` + a UUID), so the LAST one is the separator.
    const at = entry.lastIndexOf(':');
    if (at <= 0 || at === entry.length - 1) continue;
    const userId = entry.slice(0, at);
    const deviceId = entry.slice(at + 1);
    if (addedDeviceIds && !addedDeviceIds.includes(deviceId)) continue;
    admits.push({ userId, deviceId });
  }
  return admits;
}
