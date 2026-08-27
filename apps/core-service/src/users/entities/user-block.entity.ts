import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index, Unique } from 'typeorm';

/**
 * One person has blocked another.
 *
 * The row is directed - who blocked whom is recorded - but every consumer reads it SYMMETRICALLY,
 * asking only whether a row exists between two accounts in either direction. That is deliberate:
 * a block that only stopped the blocked person would let the blocker re-open the conversation they
 * just closed, which turns "block" into a one-way channel rather than a closed door. The direction
 * is kept because only the blocker may lift it.
 *
 * See migration `007_user_blocks.sql` for why the table lives in core-service and is read directly
 * by chat-delivery-service and social-service.
 */
@Entity('user_blocks')
@Unique(['blockerId', 'blockedId'])
export class UserBlock {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The account that asked for the block, and the only one that may remove it. */
  @Column({ type: 'varchar', length: 255 })
  @Index()
  blockerId!: string;

  /** The account being blocked. Never told about it. */
  @Column({ type: 'varchar', length: 255 })
  @Index()
  blockedId!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
