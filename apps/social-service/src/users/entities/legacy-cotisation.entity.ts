import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * A cotisation recorded by a legacy estate (Le Cercle's pre-2026 database, the BDE's spreadsheet)
 * whose holder may not have a Canari account yet.
 *
 * The row waits until someone signs in whose `(lastName, firstName, promo)` normalizes to the same
 * `matchKey`, at which point the claim grants the tag through `grantCotisant` and stamps
 * `claimedByUserId`/`claimedAt` in the same transaction. That stamp is the durable state the claim
 * terminates on - not a "first login" flag, which would strand everyone who signed in before their
 * list was loaded and would make a failed grant unrecoverable.
 *
 * See migration `059_legacy_cotisations_staging.sql` for why this is staged rather than granted in
 * one pass, and `docs/wiki/cotisations.md` for the wider model.
 */
@Entity('legacy_cotisations')
export class LegacyCotisation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Normalized `<lastName>|<firstName>|<promo>`, built by `normalizeMatchKey` - the one implementation. */
  @Column({ length: 200 })
  @Index()
  matchKey: string;

  /** What the source said, verbatim, so a human arbitrating a refused row reads a person. */
  @Column({ length: 200 })
  sourceLabel: string;

  /** Association that recorded the dues. No FK: `user_tags` has none either, for the same reason. */
  @Column({ type: 'uuid' })
  associationId: string;

  /** Tier to grant, validated against the association's catalogue by `grantCotisant`; null = base tier. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  variantKey: string | null;

  /** Which load put the row here, e.g. `"cercle-legacy-2026-09"`. */
  @Column({ length: 100 })
  sourceBatch: string;

  /** The user who claimed it; null while the row is still waiting. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  claimedByUserId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  claimedAt: Date | null;

  /** Provenance of the row (legacy id, source file, purchase date). */
  @Column({ type: 'jsonb', default: '{}' })
  metadata: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;
}
