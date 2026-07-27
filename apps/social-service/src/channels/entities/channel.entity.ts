import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
  UpdateDateColumn,
} from 'typeorm';

/** TypeORM entity representing a channel within a workspace. */
@Entity('channels')
@Index(['workspaceId', 'name'], { unique: true })
export class Channel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  workspaceId: string;

  @Column()
  name: string;

  @Column({ default: false })
  isPrivate: boolean;

  @Column('simple-array', { default: '' })
  allowedRoles: string[];

  @Column('simple-array', { default: '' })
  allowedUsers: string[];

  /**
   * Who may post in this channel. `everyone` (default) lets any member with access write;
   * `admins_moderators` restricts posting to roles carrying channel.moderate or workspace.manage;
   * `admins` restricts it to roles carrying workspace.manage. Reading is unaffected.
   */
  @Column({ type: 'varchar', default: 'everyone' })
  writePolicy: 'everyone' | 'admins_moderators' | 'admins';

  @Column({ default: 1 })
  keyVersion: number;

  @Column({ nullable: true })
  masterSecret: string;

  @Column({ default: false })
  archived: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
