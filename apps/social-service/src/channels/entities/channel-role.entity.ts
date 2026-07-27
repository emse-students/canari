import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
  AfterLoad,
} from 'typeorm';
import { LEGACY_PERMISSION_MAPPING } from '../permissions';

/** TypeORM entity representing a named role within a workspace, holding an ordered permission set. */
@Entity('channel_roles')
@Index(['workspaceId', 'name'], { unique: true })
export class ChannelRole {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  workspaceId: string;

  @Column()
  name: string;

  @Column()
  priority: number;

  @Column('simple-array', { default: '' })
  permissions: string[];

  @CreateDateColumn()
  createdAt: Date;

  /**
   * Normalizes legacy permissions (MANAGE_WORKSPACE, SEND_MESSAGES, etc.) to the new unified
   * keys (workspace.manage, channel.send, etc.) when loading from the database. Guarantees that
   * all downstream code works with the new keys, even if the database still holds old values.
   */
  @AfterLoad()
  normalizePermissions() {
    if (!this.permissions || this.permissions.length === 0) return;
    this.permissions = this.permissions.map((perm) => LEGACY_PERMISSION_MAPPING[perm] ?? perm);
  }
}
