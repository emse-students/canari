import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index, Unique } from 'typeorm';

/**
 * Discord-style permission flags for association members.
 * Each flag is an independent capability — combine with bitwise OR.
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
  /** Create a new association without global-admin approval (BDE only). */
  CREATE_ASSO = 1 << 6,
  /** Delete posts, mute users and review content reports (BDE only). */
  MODERATE = 1 << 7,
  /** Create, edit and delete boutique products. */
  MANAGE_PRODUCTS = 1 << 8,
}

/**
 * All non-BDE flags granted to existing admins during the
 * `permission → permissions` migration.
 * = POST_AS_ASSO | PROPOSE_EVENT | MANAGE_MEMBERS | MANAGE_DOCUMENTS | MANAGE_FORMS | MANAGE_PRODUCTS
 */
export const ALL_CORE_FLAGS =
  AssociationPermissionFlag.POST_AS_ASSO |
  AssociationPermissionFlag.PROPOSE_EVENT |
  AssociationPermissionFlag.MANAGE_MEMBERS |
  AssociationPermissionFlag.MANAGE_DOCUMENTS |
  AssociationPermissionFlag.MANAGE_FORMS |
  AssociationPermissionFlag.MANAGE_PRODUCTS; // = 287

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
