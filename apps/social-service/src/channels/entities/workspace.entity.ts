import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

/** TypeORM entity representing a channel workspace (tenant grouping channels and members). */
@Entity('channel_workspaces')
export class Workspace {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  slug: string;

  @Column()
  name: string;

  @Column({ type: 'varchar', length: 255 })
  createdBy: string;

  @Column({ nullable: true, type: 'varchar' })
  imageMediaId: string | null;

  /**
   * Soft-delete tombstone. Every read path filters it out, so an archived workspace is
   * invisible to members, invites and slug lookups while its row keeps the slug reserved
   * and its data recoverable.
   */
  @Column({ default: false })
  archived: boolean;

  /**
   * `dm_groups.id` of this community's Graine key-distribution group, minted by chat-delivery when
   * the community is created and never changed afterwards.
   *
   * Null means the community predates Graine, or its group has not been created yet - a state, not
   * a fault. It is what a client needs in order to external-join and receive channel seeds; see
   * `docs/wiki/protocols/channel-encryption.md`.
   */
  @Column({ type: 'uuid', nullable: true, default: null })
  distributionGroupId: string | null;

  /**
   * What this community lets a newcomer read: `shared` (the past, by default) or `joined` (nothing
   * written before they arrived).
   *
   * Per community and not per channel, because a member joins the community's single Graine
   * distribution group and every salon's seeds travel on it. Enforced entirely CLIENT-SIDE, by the
   * member answering the history request - the server holds no seed and could not enforce it if it
   * wanted to. Storing it here is what lets every device read the same answer.
   *
   * See `docs/wiki/protocols/channel-encryption.md`.
   */
  @Column({ type: 'varchar', length: 16, default: 'shared' })
  historyVisibility: string;

  @CreateDateColumn()
  createdAt: Date;
}
