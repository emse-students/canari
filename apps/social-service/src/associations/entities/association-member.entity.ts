import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index, Unique } from 'typeorm';

/**
 * Permission flags for association members.
 * Each flag is an independent capability - combine with bitwise OR.
 */
export enum AssociationPermissionFlag {
  /** Post content on behalf of the association (not as an individual). */
  POST_AS_ASSO = 1 << 0,
  /** Submit event proposals to the BDE validation queue. */
  PROPOSE_EVENT = 1 << 1,
  /** Manage members and their permission flags. */
  MANAGE_MEMBERS = 1 << 2,
  /** Access, upload and delete private association documents. */
  MANAGE_DOCUMENTS = 1 << 3,
  /** Create/edit/delete forms and view their submissions. */
  MANAGE_FORMS = 1 << 4,
  /** Validate, modify and delete events from any association (BDE only). */
  VALIDATE_EVENTS = 1 << 5,
  /**
   * Create new associations and administer ANY association as if a member with
   * full management rights - dashboard, members, documents, forms, products
   * (BDE only). Does not include deleting an association or toggling its BDE
   * status, which stay global-admin-only.
   */
  MANAGE_ASSO = 1 << 6,
  /** Delete posts, mute users and review content reports (BDE only). */
  MODERATE = 1 << 7,
  /** Create, edit and delete boutique products. */
  MANAGE_PRODUCTS = 1 << 8,
  /** Start or resume Stripe Connect onboarding for the association. */
  MANAGE_STRIPE_CONNECT = 1 << 9,
  /** Create, edit and delete partnership cards, and view/add their codes. */
  MANAGE_PARTNERSHIPS = 1 << 10,
}

/**
 * Every flag the enum defines, OR-ed together - the widest legal `permissions` bitmask.
 *
 * Derived from the enum rather than written down, because the literal that preceded it had to be
 * raised by hand on every new flag and was not: `@Max(511)` became `@Max(1023)` for
 * MANAGE_STRIPE_CONNECT (bit 9) and then stayed at 1023 when MANAGE_PARTNERSHIPS (bit 10) landed,
 * so the server rejected the admin preset outright. This constant is the ONLY bound the member
 * DTOs may use; adding a flag to the enum above moves it with no second edit.
 *
 * TypeScript reverse-maps numeric enums, so `Object.values` yields the names too - hence the
 * numeric filter.
 */
export const ALL_PERMISSION_FLAGS = Object.values(AssociationPermissionFlag)
  .filter((value): value is AssociationPermissionFlag => typeof value === 'number')
  .reduce<number>((mask, flag) => mask | flag, 0);

/**
 * Base admin flags granted to association admins.
 * = POST_AS_ASSO | PROPOSE_EVENT | MANAGE_MEMBERS | MANAGE_DOCUMENTS | MANAGE_FORMS |
 *   MANAGE_PRODUCTS | MANAGE_PARTNERSHIPS
 * = 1311
 *
 * Intentionally excludes:
 * - MANAGE_STRIPE_CONNECT (1 << 9): sensitive financial flag, granted separately via
 *   ASSOCIATION_ADMIN_PRESET in the frontend or via migration 004. Admins who should
 *   manage Stripe onboarding must be explicitly granted this flag.
 * - VALIDATE_EVENTS / MANAGE_ASSO / MODERATE: BDE-only flags with no effect in
 *   non-BDE associations (guarded by `a.isBDE = true` in service queries).
 */
export const ALL_CORE_FLAGS =
  AssociationPermissionFlag.POST_AS_ASSO |
  AssociationPermissionFlag.PROPOSE_EVENT |
  AssociationPermissionFlag.MANAGE_MEMBERS |
  AssociationPermissionFlag.MANAGE_DOCUMENTS |
  AssociationPermissionFlag.MANAGE_FORMS |
  AssociationPermissionFlag.MANAGE_PRODUCTS |
  AssociationPermissionFlag.MANAGE_PARTNERSHIPS; // = 1311

/** TypeORM entity representing a user's membership in an association. */
@Entity('association_members')
@Unique(['associationId', 'userId'])
export class AssociationMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  associationId: string;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  userId: string;

  @Column({ type: 'varchar', default: 'Membre' })
  role: string;

  /**
   * Bitmask of `AssociationPermissionFlag` values.
   * 0 = simple member (read-only access); any flag > 0 = some admin right.
   */
  @Column({ type: 'integer', default: 0 })
  permissions: number;

  /** Display position in the public members list. Lower values appear first. */
  @Column({ type: 'integer', default: 0 })
  sortOrder: number;

  @CreateDateColumn()
  createdAt: Date;
}
