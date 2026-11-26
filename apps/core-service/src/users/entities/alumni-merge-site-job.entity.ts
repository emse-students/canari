import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { AlumniMerge } from './alumni-merge.entity';

/**
 * One sibling site's part of one completed Alumni merge (D53, D54; migration 030): the site moves
 * what the duplicate's account owns onto the target's subject and erases the rest, and answers what
 * it did. `AlumniMergeSiteJobsService` owns every read and write, in raw SQL (its claim needs
 * `FOR UPDATE SKIP LOCKED`); this class exists so the table is registered and built by
 * `synchronize` outside production.
 *
 * Its state is read from the timestamps: pending (`completedAt` and `blockedAt` null), blocked
 * (`blockedAt`: the site refused on its own state, a typed 409 no retry can change), completed
 * (`completedAt`, with the site's `outcome`). One row per merge and site. Erased with its merge
 * (`ON DELETE CASCADE`).
 */
@Entity('alumni_merge_site_jobs')
@Index('UQ_alumni_merge_site_jobs_merge_site', ['mergeId', 'site'], { unique: true })
export class AlumniMergeSiteJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  mergeId!: string;

  /** The foreign key, so a `synchronize` stack cascades the erasure of the merge as migration 030 does. */
  @ManyToOne(() => AlumniMerge, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mergeId' })
  merge?: AlumniMerge;

  /** A site id of `libs/contracts/ecosystem-sites.json`: `sky`, `migallery` or `le-cercle`. */
  @Column({ type: 'varchar', length: 32 })
  site!: string;

  /** The duplicate's OIDC subject, by which the site finds its account. */
  @Column({ type: 'varchar', length: 255 })
  duplicateSubject!: string;

  /** The target's OIDC subject, onto which the site moves it. */
  @Column({ type: 'varchar', length: 255 })
  targetSubject!: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  /** Failed attempts so far; a success does not count. */
  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastAttemptAt!: Date | null;

  /** The last failure, as a status or an error code, or the site's typed refusal. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  lastError!: string | null;

  /** Set when the site refused on its own state (a typed 409): no retry, an ERROR line. */
  @Column({ type: 'timestamptz', nullable: true })
  blockedAt!: Date | null;

  /** What the site did: `absent`, `transferred` or `merged`. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  outcome!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
