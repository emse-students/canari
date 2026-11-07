import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { KEY_PACKAGE_LIFETIME_DAYS } from './key-package.entity';

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

  /** Owner of the device this one-time key package belongs to. */
  @Index()
  @Column({ type: 'varchar', length: 255 })
  userId: string;

  /** Opaque client-generated device identifier. */
  @Column()
  deviceId: string;

  /** Base64-encoded serialised MLS KeyPackage, consumed once when a peer adds this device to a group. */
  @Column({ type: 'text' })
  keyPackage: string; // Base64 encoded MLS KeyPackage

  @CreateDateColumn()
  createdAt: Date;

  /**
   * When this package stops being usable, from its own MLS `Lifetime`, reported by the client that
   * minted it.
   *
   * **THE SERVER CANNOT WORK IT OUT, AND THAT IS THE WHOLE REASON THE COLUMN EXISTS.** `keyPackage`
   * is an opaque base64 blob here; parsing an MLS KeyPackage needs the client's WASM crate. Without
   * this, `resolveKeyPackagePayloadForDevice` handed out elapsed packages - and it DELETES a row as
   * it serves it, so a failed join consumed the package anyway.
   *
   * Nullable only for the rows that predate migration 024, which backfills them from
   * `createdAt + 84 days` - exact for this table, whose rows are inserted once and never updated.
   */
  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  notAfter: Date | null;
}

/**
 * The SQL predicate a one-time row must meet to be a package at all: its own `notAfter`, or one
 * lifetime past its `createdAt` when no client dated it. ONE spelling, read by the claim, the peek
 * and the pool count (`DevicesController`) and, negated, by the reclaim (`reclaimExpiredKeyPackages`),
 * so "usable" cannot mean two things. Why the undated arm is sound is written at the claim
 * (`resolveKeyPackagePayloadForDevice`).
 *
 * @param alias The query builder's alias for the table, or none for a statement that has none (a
 *   TypeORM DELETE names the bare table).
 */
export function usableOneTimePackage(alias?: string): string {
  const col = (name: string) => (alias ? `${alias}."${name}"` : `"${name}"`);
  return `COALESCE(${col('notAfter')}, (${col('createdAt')} AT TIME ZONE 'UTC') + interval '${KEY_PACKAGE_LIFETIME_DAYS} days') > now()`;
}
