import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * Audit record for outbound Cercle balance_topup webhook deliveries.
 * Failures are retried manually from the admin dashboard.
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

  @CreateDateColumn()
  createdAt: Date;
}
