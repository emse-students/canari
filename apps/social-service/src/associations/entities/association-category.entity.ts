import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * A managed thematic category used to group associations on the "Carte de la Vie Asso"
 * poster and its text directory (e.g. "Cuisine", "Culture, Arts").
 *
 * Categories are data, not a hardcoded enum: they are editable in admin, so a zone can be
 * added / renamed / reordered without a migration or deploy. Each association points to at
 * most one category via {@link Association.categoryId} (nullable = uncategorised). The poster
 * editor may still override a single bubble's zone without touching this canonical value.
 */
@Entity('association_categories')
export class AssociationCategory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Human-facing label shown as a directory heading, e.g. "Cuisine, Decouverte culinaire". */
  @Column({ type: 'varchar', length: 100 })
  label: string;

  /** Stable URL-safe identifier, e.g. "cuisine". Unique across categories. */
  @Column({ type: 'varchar', length: 60, unique: true })
  @Index()
  slug: string;

  /** Display order on the poster and directory (ascending; ties broken by label). */
  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
