import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * One-time prekey pool for a device.
 * Unlike the `KeyPackage` entity (which stores a single registration key per device),
 * this table holds a replenishable pool of one-time-use MLS key packages.
 * Each Welcome message consumes one entry from this pool (FIFO).
 * Falls back to the static `KeyPackage` when the pool is exhausted.
 */
@Entity()
@Index(['userId', 'deviceId'])
export class OneTimeKeyPackage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  userId: string;

  @Column()
  deviceId: string;

  @Column({ type: 'text' })
  keyPackage: string; // Base64 encoded MLS KeyPackage

  @CreateDateColumn()
  createdAt: Date;
}
