import { Entity, PrimaryColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * A KEY group a REVOKED device held when its revocation purged its rows - one row per
 * `(groupId, userId, deviceId)` (migration 041).
 *
 * **WHAT IT IS FOR: THE BINDING A PURGE CANNOT REACH.** `POST mls/groups/:groupId/revoked-leaves`
 * answers about a leaf only when its user is bound to the group, and a key group has no seats: the
 * binding is the user's device rows, which a revocation deletes (`purgeDeviceFootprint`). This row is
 * written in the SAME transaction as that delete, for the key groups the device held, so the exact
 * revoked leaf stays answerable after its rows are gone. It binds THAT device to THAT group and
 * nothing else - it is not a membership, and no route, seat or delivery reads it.
 *
 * NOT a status on the device row: `dm_device_group_memberships` is read by every routing and
 * admission path, and a `revoked` row there would be a denylist each of them must learn to skip.
 *
 * Ends on STATE, never on a clock: deleted when an accepted commit DECLARES the Remove of that device
 * (or of its user) in that group (`MessagingService.endRevokedDeviceBindings`), with the group
 * (`GROUP_OWNED_TABLES`) and with the account. FORWARD-ONLY: a device revoked before this table
 * existed has no row, and nothing here reconstructs one.
 */
@Entity('dm_revoked_device_groups')
@Index('IDX_dm_revoked_device_groups_group_user', ['groupId', 'userId'])
export class RevokedDeviceGroup {
  /** The key group the revoked device held a leaf in. */
  @PrimaryColumn({ type: 'uuid' })
  groupId: string;

  /** Owner of the revoked device, as its device rows spelt it. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  userId: string;

  /** The revoked device. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  deviceId: string;

  /** When the revocation's purge wrote it (diagnostic only - nothing is decided on it). */
  @CreateDateColumn()
  recordedAt: Date;
}
