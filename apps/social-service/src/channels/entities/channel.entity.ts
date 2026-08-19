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

  /**
   * Who may open this salon when it is private, named PERSON BY PERSON.
   *
   * There is deliberately no `allowedRoles` beside it. That column existed, was written as empty at
   * every creation site and read by nothing, for as long as it existed - dropped 2026-08-19 with
   * migration 044. Access to a private salon is granted by invitation, and an invitation names a
   * person; a role-shaped grant would have had to answer what happens when the role changes under
   * a salon somebody is already reading, and nothing ever needed to ask.
   */
  @Column('simple-array', { default: '' })
  allowedUsers: string[];

  /**
   * Who may post in this channel. `everyone` (default) lets any member with access write;
   * `admins_moderators` restricts posting to roles carrying channel.moderate or workspace.manage;
   * `admins` restricts it to roles carrying workspace.manage. Reading is unaffected.
   */
  @Column({ type: 'varchar', default: 'everyone' })
  writePolicy: 'everyone' | 'admins_moderators' | 'admins';

  @Column({ default: false })
  archived: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
