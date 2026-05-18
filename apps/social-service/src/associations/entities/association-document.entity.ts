import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Metadata record for a document stored in an association's encrypted vault.
 * The actual bytes are stored as an opaque encrypted blob in media-service.
 * The CEK is derived client-side via HKDF(vaultKey, salt=id, info="doc-vault").
 */
@Entity('association_documents')
export class AssociationDocument {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  associationId: string;

  /** Display name shown in the vault UI. Case-insensitive duplicate check per association. */
  @Column({ length: 200 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** UUID in media-service where the AES-256-GCM ciphertext is stored. */
  @Column({ type: 'uuid' })
  mediaId: string;

  @Column({ length: 255 })
  mimeType: string;

  /** Original file size in bytes (before encryption). */
  @Column({ type: 'bigint' })
  size: number;

  @Column()
  uploadedBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
