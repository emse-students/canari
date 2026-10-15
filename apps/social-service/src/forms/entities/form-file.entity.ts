import { Entity, Column, PrimaryColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * A file uploaded for a FILE question of a form (migration 085).
 *
 * The answer carries only this row's id; everything a manager's download needs, and everything the
 * purge decides from, is here. THE STATE IS THE ROW: `submissionId` null means "uploaded, not yet
 * sent" (attachable for a day, then purged with its row), set means "an answer's file" (purged
 * `fileRetentionDays` after `attachedAt`), and `purgedAt` means the blob is gone while the answer
 * stays. See `form-files.service.ts`.
 */
@Entity('form_files')
export class FormFile {
  /** The media service's object id - the same string the answer stores. */
  @PrimaryColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  formId: string;

  /** The question it was uploaded for; an answer may cite it under that question only. */
  @Column({ type: 'varchar', length: 64 })
  itemId: string;

  @Column({ type: 'varchar', length: 255 })
  uploaderId: string;

  /** Read from the bytes at upload (`detectFormFileType`), never from the client's declaration. */
  @Column({ type: 'varchar', length: 64 })
  contentType: string;

  /** The name the member's device gave it, cleaned for a `Content-Disposition` header. */
  @Column({ type: 'varchar', length: 255 })
  fileName: string;

  @Column({ type: 'int' })
  sizeBytes: number;

  /** Foreign key `form_files_submission_fk` ON DELETE SET NULL: a deleted answer's file is an orphan. */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  submissionId: string | null;

  /** The date of the answer it was sent with: the start of its retention. */
  @Column({ type: 'timestamptz', nullable: true })
  attachedAt: Date | null;

  /** Set once the media service said the blob is gone; the answer row is kept. */
  @Column({ type: 'timestamptz', nullable: true })
  purgedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
