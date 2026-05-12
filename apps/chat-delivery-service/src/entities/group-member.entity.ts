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
 * single GroupMember row. The `leftAt` timestamp is set rather than deleting
 * the row so that historical participant lists remain queryable.
 */
@Entity('dm_group_members')
@Unique(['groupId', 'userId'])
export class GroupMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Group this membership belongs to. */
  @Column({ type: 'uuid' })
  groupId: string;

  /** User who is (or was) a member of the group. */
  @Column({ type: 'varchar', length: 255 })
  userId: string;

  /** Permission level: `admin` can add/remove members; `member` can only send messages. */
  @Column({ type: 'enum', enum: ['admin', 'member'], default: 'member' })
  role: 'admin' | 'member';

  @CreateDateColumn()
  joinedAt: Date;

  /** Set when the user leaves or is removed; null while still an active member. */
  @Column({ type: 'timestamp', nullable: true, default: null })
  leftAt?: Date | null;
}
