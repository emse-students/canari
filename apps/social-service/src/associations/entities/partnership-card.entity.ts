import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/** How a student obtains proof of eligibility for a partnership. */
export type PartnershipClaimMode = 'code_pool' | 'shared_code' | 'text';

/**
 * A partner discount offered by an association (e.g. a local business promo).
 * Exactly one of `sharedCode`/`staticText` is populated, matching `claimMode`; `code_pool` mode
 * hands out individual rows from `PartnershipCode` instead and leaves both null.
 */
@Entity('partnership_cards')
export class PartnershipCard {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  associationId: string;

  @Column({ length: 200 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ length: 500, nullable: true })
  link: string | null;

  /** Chosen at creation and not updatable afterwards - see `PartnershipsService.assertModeShape`. */
  @Column({ length: 20 })
  claimMode: PartnershipClaimMode;

  /** Single code shared by every claimant. Populated only when `claimMode === 'shared_code'`. */
  @Column({ length: 200, nullable: true })
  sharedCode: string | null;

  /** Static instruction shown instead of a code. Populated only when `claimMode === 'text'`. */
  @Column({ length: 500, nullable: true })
  staticText: string | null;

  /** Reserved to holders of the association's active cotisation tag (mirrors `AssociationProduct.membersOnly`). */
  @Column({ default: false })
  membersOnly: boolean;

  /** When false, hidden from students but claim history is preserved. */
  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'varchar', nullable: true })
  iconUrl: string | null;

  /** Media-service UUID for GET /api/media/public/:id (opaque blob in Garage). */
  @Column({ type: 'uuid', nullable: true })
  iconMediaId: string | null;

  /** Short decorative label shown as a pill on the card (e.g. "Nouveau", "Offre limitée"). */
  @Column({ length: 30, nullable: true })
  badgeText: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
