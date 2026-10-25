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

  /**
   * Position in the community's list of salons, shared by every member and arranged by whoever may
   * manage salons (`PATCH workspaces/:id/channels/reorder`). Ties break on `createdAt`.
   */
  @Column({ type: 'int', default: 0 })
  sortOrder: number;

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

  /**
   * The revision of this salon's ACCESS - `isPrivate`, `allowedUsers` and `writePolicy` - raised by
   * one on every write of any of the three, by every writer (an access rewrite, a grant, a roster
   * strip, an account erasure's name drop).
   *
   * WHY A NUMBER AND NOT THE LIST. The settings panel rewrites the whole list it holds, and the list
   * it holds is the one it read when it opened; a grant committed since then was absent from it, and
   * diffing the two read the newcomer as a removal - cut from the key distribution, answered 200. The
   * panel now sends the revision it edited (`baseAccessRevision`) and a rewrite of a revision that is
   * no longer current is refused with `409 CHANNEL_ACCESS_CHANGED`. See
   * docs/wiki/services/social-service.md, "An access rewrite names the revision it edited".
   */
  @Column({ type: 'int', default: 0 })
  accessRevision: number;

  /**
   * `dm_groups.id` of this salon's OWN Graine key-distribution group, set only when it is private.
   *
   * A private salon's seeds are sealed to the people who may open it, and nobody else - which is
   * what makes the guarantee cryptographic rather than merely server-enforced. A public salon has
   * none and must not: its audience IS the community, so the community's group is already the right
   * roster and a second one would be the same people at a higher commit rate.
   *
   * It follows `isPrivate` in both directions: minted when a salon becomes private, tombstoned when
   * it becomes public or goes away. Null on a public salon is the ordinary state, not a repair.
   */
  @Column({ type: 'uuid', nullable: true, default: null })
  distributionGroupId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
