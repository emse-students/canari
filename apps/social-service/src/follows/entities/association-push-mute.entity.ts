import { Entity, CreateDateColumn, PrimaryColumn } from 'typeorm';

/**
 * One account silencing the PUSH of one association. The row is the whole fact: it is not a
 * follow, it never touches the feed, and it is read only by `PostNotificationsService` when it
 * decides whom to push (migration 079).
 */
@Entity('association_push_mutes')
export class AssociationPushMute {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  userId: string;

  @PrimaryColumn({ type: 'uuid' })
  associationId: string;

  @CreateDateColumn()
  createdAt: Date;
}
