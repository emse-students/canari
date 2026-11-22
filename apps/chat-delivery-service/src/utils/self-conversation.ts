import type { EntityManager } from 'typeorm';
import { Group, isSelfConversation } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';

/**
 * THE "MES NOTES" CAPABILITY A BUILD MUST STATE to be given a self group (migration 056). A build
 * that does not know the self kind reads a self group it is Welcomed into as an ordinary group it may
 * rename, invite into and DELETE - and its delete tombstones the notes on every device of the account
 * (charter principle 2). So the device's own statement on `register-device`
 * (`key_package."selfConversationVersion"`) decides, never a guess from its version string.
 * docs/wiki/legacy-compatibility.md ("Mes notes")
 */
export const SELF_CONVERSATION_VERSION = 1;

/**
 * The capability a registration states: a non-negative integer, else 0 (states nothing - every
 * build before "Mes notes", and any unreadable value: fail closed).
 */
export function parseSelfConversationVersion(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 32767 ? raw : 0;
}

/** A device named by its owner and id, as every seat and admit names one. */
export interface DeviceRef {
  userId: string;
  deviceId: string;
}

/**
 * The devices of `devices` that may NOT be given `group` because it is a self group and their build
 * does not know the kind (or they have no key package at all): an empty list for any other group,
 * which costs no read. The caller hands in the group row it already read (its `kind`), so the
 * predicate adds a query only where it decides something. Read through `m`, so a caller inside a
 * transaction reads what its locks hold.
 *
 * THE ONE PREDICATE for every door a device can enter a self group by - a pending seat
 * (`writePendingSeats`), an Admit or an external join in a commit, a stored Welcome
 * (`lockWelcomeSeat`), a welcome request (`notifyWelcomeRequest`).
 */
export async function selfConversationUnawareDevices(
  m: EntityManager,
  group: Pick<Group, 'kind'> | null | undefined,
  devices: readonly DeviceRef[]
): Promise<DeviceRef[]> {
  if (devices.length === 0 || !isSelfConversation(group)) return [];
  const rows = await m.getRepository(KeyPackage).find({
    where: devices.map(({ userId, deviceId }) => ({ userId, deviceId })),
    select: { userId: true, deviceId: true, selfConversationVersion: true },
  });
  const able = new Set(
    rows
      .filter((r) => (r.selfConversationVersion ?? 0) >= SELF_CONVERSATION_VERSION)
      .map((r) => `${r.userId}:${r.deviceId}`)
  );
  return devices.filter((d) => !able.has(`${d.userId}:${d.deviceId}`));
}

/** Whether `device`'s build stated the "Mes notes" capability on its last registration. */
export async function deviceKnowsSelfConversation(
  m: EntityManager,
  device: DeviceRef
): Promise<boolean> {
  const row = await m.getRepository(KeyPackage).findOne({
    where: { userId: device.userId, deviceId: device.deviceId },
    select: { id: true, selfConversationVersion: true },
  });
  return (row?.selfConversationVersion ?? 0) >= SELF_CONVERSATION_VERSION;
}

/**
 * How many devices OTHER than `exceptDeviceId` hold `groupId`: an `active` device membership whose
 * device still has its key package (a revoked or erased device has none). The fact a device that
 * could not create "Mes notes" (`SELF_CONVERSATION_EXISTS`) needs: a holder means a Welcome can come
 * to it; none means nothing can - the conversation is unreadable to every device that is left.
 */
export async function countOtherSelfHolders(
  m: Pick<EntityManager, 'query'>,
  groupId: string,
  userId: string,
  exceptDeviceId: string
): Promise<number> {
  const rows = (await m.query(
    `SELECT COUNT(*)::int AS n
       FROM dm_device_group_memberships d
       JOIN key_package k ON k."userId" = d."userId" AND k."deviceId" = d."deviceId"
      WHERE d."groupId" = $1 AND d."userId" = $2 AND d."status" = 'active' AND d."deviceId" <> $3`,
    [groupId, userId, exceptDeviceId]
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}
