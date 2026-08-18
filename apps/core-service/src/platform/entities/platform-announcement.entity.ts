import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One published announcement, shown once per ACCOUNT at the next app opening.
 *
 * Both languages are stored and BOTH are sent to the client, which picks with the locale the user
 * chose inside Canari. The server never composes the sentence it shows: it is the only layer that
 * does not know the reader's language, and a `locale` column here would be that same mistake
 * written down (see the notification-body item in `docs/wiki/backlog.md`).
 *
 * The version range is a FILTER, not a gate. A client outside it is never told an announcement
 * exists and refused - it simply has none, which is why the comparison happens server-side.
 */
@Entity('platform_announcements')
export class PlatformAnnouncement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Modal title, French. */
  @Column({ name: 'title_fr', type: 'text' })
  titleFr!: string;

  /** Modal title, English. */
  @Column({ name: 'title_en', type: 'text' })
  titleEn!: string;

  /** Modal body, French. */
  @Column({ name: 'body_fr', type: 'text' })
  bodyFr!: string;

  /** Modal body, English. */
  @Column({ name: 'body_en', type: 'text' })
  bodyEn!: string;

  /**
   * Lowest client semver that may see this, inclusive. Null means no lower bound.
   * Lets "what changed in 0.15" reach only the clients that actually have 0.15.
   */
  @Column({ name: 'min_client_version', type: 'varchar', length: 32, nullable: true })
  minClientVersion!: string | null;

  /** Highest client semver that may see this, inclusive. Null means no upper bound. */
  @Column({ name: 'max_client_version', type: 'varchar', length: 32, nullable: true })
  maxClientVersion!: string | null;

  /**
   * Whether this is THE announcement being shown. At most one row is true at a time, held by a
   * partial unique index in the migration rather than by service code alone - two active rows
   * would make "the announcement" ambiguous for every reader at once.
   */
  @Column({ name: 'active', type: 'boolean', default: true })
  active!: boolean;

  /** Global admin who published it, for the audit trail. */
  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
