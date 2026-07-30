import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * A saved, re-editable "Carte de la Vie Asso" poster layout.
 *
 * Stores layout ONLY (bubble positions/sizes, doodles, free text, theme, background) as an
 * opaque JSON document; the live content (association colors, logos, members, avatars) is
 * re-resolved at render time, so a regenerated map is always current even if a president or
 * roster changed since the layout was saved. See docs/wiki/carte-vie-asso.md for the shape.
 *
 * Managed by global admins and BDE super-admins (see GlobalAdminOrBdeSuperAdminGuard).
 */
@Entity('poster_projects')
export class PosterProject {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Author-chosen name, e.g. "Carte 2026". */
  @Column({ type: 'varchar', length: 120 })
  name: string;

  /**
   * Opaque layout document: bubbles (assoId, x/y, radius, overrides, polaroids, roster
   * lines), doodles, free texts, theme preset and background. Never holds resolved rosters.
   */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  layout: Record<string, unknown>;

  /**
   * The artefact published to the public showcase, or null when this poster is not live.
   *
   * Deliberately separate from {@link layout}: it is the normalized, validated geometry document
   * defined by `published-carte.ts`, so the editor can rev its own layout schema without breaking
   * the contract portail-etu reads. A partial unique index (migration 035) allows at most one
   * non-null row, making "one live map at a time" a database invariant.
   */
  @Column({ type: 'jsonb', nullable: true })
  publication: Record<string, unknown> | null;

  /** When this poster was last published; null when it is not live. */
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  /** OIDC subject of the creator. */
  @Column({ type: 'varchar', length: 255 })
  @Index()
  createdBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
