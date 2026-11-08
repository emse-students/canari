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

  /**
   * The role's IDENTITY (the names `createWorkspace` seeds: Administrateur, the accented moderator name, Membre), never edited after the seed:
   * lookups and the admin / moderator / member fold read it. NOT what a screen shows - see
   * `displayLabel`.
   */
  @Column()
  name: string;

  /**
   * The community's own name for this role, or null for "none: use the localized default".
   * LABEL ONLY: no permission and no role lookup ever reads it (migration 150).
   */
  @Column({ type: 'varchar', length: 40, nullable: true })
  displayLabel: string | null;

  @Column()
  priority: number;

  @Column('simple-array', { default: '' })
  permissions: string[];

  @CreateDateColumn()
  createdAt: Date;

  /**
   * Normalizes legacy permissions (MANAGE_WORKSPACE, MANAGE_CHANNELS, etc.) to the new unified
   * keys (workspace.manage, channel.manage, etc.) when loading from the database. Guarantees that
   * all downstream code works with the new keys, even if the database still holds old values.
   *
   * A key with no mapping is passed through unchanged, which is deliberate: this normalizes
   * spelling, it does not decide what exists. Whether a key means anything is settled at the two
   * places that ask - the write path validates against the registry, and every read is an
   * `includes` of a key that IS in it, so an unknown value simply never matches.
   */
  @AfterLoad()
  normalizePermissions() {
    if (!this.permissions || this.permissions.length === 0) return;
    this.permissions = this.permissions.map((perm) => LEGACY_PERMISSION_MAPPING[perm] ?? perm);
  }
}
