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
 * A map belongs to ONE space (migration 147): the managers of the BDE governing that space create,
 * edit and publish it, and the platform admin reaches every map (`poster-scope.ts`).
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
   * the contract portail-etu reads. A partial unique index on {@link spaceId} among published rows
   * (migration 147, replacing 035's single global one) allows at most one live map PER SPACE, and a
   * CHECK refuses a live map with no space.
   */
  @Column({ type: 'jsonb', nullable: true })
  publication: Record<string, unknown> | null;

  /** When this poster was last published; null when it is not live. */
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  /**
   * Fingerprint of the document that actually went live, so the editor can say the live map is
   * older than what has been saved. Null when this poster is not live.
   *
   * No other column can answer that question: `publish()` writes the row, so `updatedAt` moves
   * together with {@link publishedAt} in the same statement, and separating them would decide
   * staleness by a millisecond of clock. It covers the layout AND the content (user, D14) because
   * the published document embeds the rosters - a member joining really does make the live map old.
   *
   * Computed by the CLIENT over the document it builds and sends, since that document is built
   * client-side: one implementation therefore decides both sides of the comparison. It is a
   * staleness hint and nothing downstream trusts it for anything else.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  publicationFingerprint: string | null;

  /**
   * The space (formation x campus) this map is drawn for, or null for a map created before
   * migration 147 that could not be attached to one: such a map is the platform admin's alone until
   * it is attached from the editor, and it can never be live (the CHECK of migration 147).
   */
  @Column({ type: 'uuid', nullable: true })
  spaceId: string | null;

  /** OIDC subject of the creator. */
  @Column({ type: 'varchar', length: 255 })
  @Index()
  createdBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
