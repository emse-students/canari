import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';

/**
 * Global grant allowing a specific user to review every association's *public*
 * documents on the cross-association reviewer page (`/documents`). Intended for
 * school / Maison des eleves staff who are neither association members nor
 * platform admins. Granting/revoking is restricted to global admins and BDE
 * super-admins (MANAGE_ASSO). The grant carries no decryption material: the
 * server derives a per-document CEK server-side for public documents only.
 */
@Entity('document_reviewer_grants')
@Unique(['userId'])
export class DocumentReviewerGrant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** OIDC subject of the granted reviewer. */
  @Column({ type: 'varchar', length: 255 })
  @Index()
  userId: string;

  /** OIDC subject of the admin / BDE super-admin who created the grant. */
  @Column({ type: 'varchar', length: 255 })
  grantedBy: string;

  @CreateDateColumn()
  createdAt: Date;
}
