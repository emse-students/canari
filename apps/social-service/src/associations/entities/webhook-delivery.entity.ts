import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * Audit record for outbound Cercle balance_topup webhook deliveries.
 *
 * ONE row per top-up, updated in place by every later attempt. It used to be one row per attempt,
 * which is why the admin retry button looked dead: a successful retry inserted a `delivered` row
 * and left the original `failed` one in the list, and a failed retry simply added a second failure.
 *
 * Failures are retried automatically on a backoff (`nextAttemptAt`), and manually from the admin
 * dashboard once the reason has been fixed.
 */
@Entity('webhook_deliveries')
export class WebhookDelivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  productId: string;

  @Column()
  userId: string;

  @Column({ type: 'int' })
  amountCents: number;

  @Column()
  paymentIntentId: string;

  @Column({ length: 20, default: 'pending' })
  status: 'pending' | 'delivered' | 'failed';

  @Column({ type: 'int', default: 0 })
  attemptCount: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastAttemptAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  /**
   * When the scheduler should try again, or null when it should not.
   *
   * Null on a `failed` row means the automatic ladder is exhausted and a human has to act - which
   * is exactly what the admin failure list is for.
   */
  @Column({ type: 'timestamptz', nullable: true })
  @Index()
  nextAttemptAt: Date | null;

  /**
   * How many AUTOMATIC retries have run, which is what picks the next backoff step.
   *
   * Separate from `attemptCount` on purpose: the initial dispatch already burns three attempts, so
   * a shared counter would report the automatic ladder as exhausted before it ever started. A
   * manual retry resets it - the admin fixed something, so the backoff starts over.
   */
  @Column({ type: 'int', default: 0 })
  autoRetryCount: number;

  @CreateDateColumn()
  createdAt: Date;
}
