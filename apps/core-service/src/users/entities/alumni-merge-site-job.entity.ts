import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AlumniMerge } from './alumni-merge.entity';
import { ALUMNI_MERGE_SUBJECT_MAX_LENGTH } from '../../auth/handoff/handoff-token';

/**
 * One sibling site's part of one completed Alumni merge (D53, D54; migration 030): the site moves
 * what the duplicate's account owns onto the target's subject and erases the rest, and answers what
 * it did. `AlumniMergeSiteJobsService` owns every read and write, in raw SQL (its claim needs
 * `FOR UPDATE SKIP LOCKED`); this class exists so the table is registered and built by
 * `synchronize` outside production.
 *
 * Its state is read from the timestamps: pending (`completedAt` and `blockedAt` null), unready
 * (`unreadySince`: the site answered 404, its endpoint not served yet), blocked (`blockedAt`: the site
 * refused on its own state, a typed 409 no retry can change), completed (`completedAt`, with the site's
 * `outcome`). One row per merge and site. A job carries the subjects it needs and never reads its merge
 * row: the target's erasure turns a job still owed into an `erase` and the merge row's deletion only
 * nulls `mergeId` (`ON DELETE SET NULL`) - nothing cascades to a job (migration 030).
 */
@Entity('alumni_merge_site_jobs')
@Index('UQ_alumni_merge_site_jobs_merge_site', ['mergeId', 'site'], { unique: true })
@Check(
  'CHK_alumni_merge_site_jobs_kind',
  `(kind = 'transfer' AND "targetSubject" IS NOT NULL) OR (kind = 'erase' AND "targetSubject" IS NULL)`
)
export class AlumniMergeSiteJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Null once the target's erasure deleted the merge row: the job, an `erase` by then, still runs. */
  @Column({ type: 'uuid', nullable: true })
  mergeId!: string | null;

  /** The foreign key, so a `synchronize` stack nulls it on the merge's deletion as migration 030 does. */
  @ManyToOne(() => AlumniMerge, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'mergeId' })
  merge?: AlumniMerge;

  /** A site id of `libs/contracts/ecosystem-sites.json`: `sky`, `migallery` or `le-cercle`. */
  @Column({ type: 'varchar', length: 32 })
  site!: string;

  /** `transfer` onto the target's subject, or `erase` the duplicate's account (the target was erased). */
  @Column({ type: 'varchar', length: 8, default: 'transfer' })
  kind!: 'transfer' | 'erase';

  /** The duplicate's OIDC subject, by which the site finds its account. */
  @Column({ type: 'varchar', length: ALUMNI_MERGE_SUBJECT_MAX_LENGTH })
  duplicateSubject!: string;

  /** The target's OIDC subject, onto which the site moves it; null for an `erase`. */
  @Column({ type: 'varchar', length: ALUMNI_MERGE_SUBJECT_MAX_LENGTH, nullable: true })
  targetSubject!: string | null;

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

  /** Since when the site answers 404 (its endpoint not served yet): asked again daily, no WARN per try. */
  @Column({ type: 'timestamptz', nullable: true })
  unreadySince!: Date | null;

  /** What the site did: `absent`, `transferred` or `merged`. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  outcome!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
