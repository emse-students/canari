import { Entity, Column, PrimaryColumn } from 'typeorm';

/** TypeORM entity representing a Canari user, keyed by their OIDC subject. */
@Entity('users')
export class User {
  /** OIDC `sub` - not necessarily a UUID string. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  id!: string;

  @Column({ type: 'varchar', nullable: true })
  displayName?: string | null;

  @Column({ type: 'varchar', nullable: true })
  firstName?: string | null;

  @Column({ type: 'varchar', nullable: true })
  lastName?: string | null;

  @Column({ type: 'int', nullable: true })
  promo?: number | null;

  @Column({ type: 'varchar', nullable: true })
  formation?: string | null;

  @Column({ type: 'text', nullable: true })
  bio?: string | null;

  @Column({ type: 'varchar', nullable: true })
  stripeCustomerId?: string | null;

  @Column({ type: 'boolean', default: false })
  admin?: boolean;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt?: Date;

  @Column({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
    onUpdate: 'CURRENT_TIMESTAMP',
  })
  updatedAt?: Date;
}
