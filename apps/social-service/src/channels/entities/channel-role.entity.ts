import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index, AfterLoad } from 'typeorm';
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
   * Normalise les permissions legacy (MANAGE_WORKSPACE, SEND_MESSAGES, etc.) vers
   * les nouvelles clés unifiées (workspace.manage, channel.send, etc.) au chargement
   * depuis la base de données. Garantit que tout le code en aval travaille avec les
   * nouvelles clés, même si la base contient encore d'anciennes valeurs.
   */
  @AfterLoad()
  normalizePermissions() {
    if (!this.permissions || this.permissions.length === 0) return;
    this.permissions = this.permissions.map(
      (perm) => LEGACY_PERMISSION_MAPPING[perm] ?? perm
    );
  }
}
