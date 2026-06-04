import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Unique,
} from 'typeorm';

/**
 * Records the user-level membership of a person in an MLS group, independently
 * of which specific devices that user has enrolled. A user may have multiple
 * DeviceGroupMembership rows for the same group (one per device), but only a
 * single GroupMember row.
 *
 * Lifecycle : hard-delete. When a user leaves or is removed, the row is deleted
 * (not soft-deleted). This is consistent with `removeGroupMember` which calls
 * `groupMemberRepo.delete()`. A migration dropping the former `leftAt` column
 * should be run to keep the schema clean.
 */
@Entity('dm_group_members')
@Unique(['groupId', 'userId'])
export class GroupMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Group this membership belongs to. */
  @Column({ type: 'uuid' })
  groupId: string;

  /** User who is a member of the group. */
  @Column({ type: 'varchar', length: 255 })
  userId: string;

  /** Permission level: `admin` can add/remove members; `member` can only send messages. */
  @Column({ type: 'enum', enum: ['admin', 'member'], default: 'member' })
  role: 'admin' | 'member';

  @CreateDateColumn()
  joinedAt: Date;
}
