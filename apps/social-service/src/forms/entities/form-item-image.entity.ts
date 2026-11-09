import { Entity, Column, PrimaryColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * An image a form question shows (migration 136) - a public asset at the media service, cited from
 * `forms.items[].imageUrl`. The row is the allowlist of its release: see
 * `form-item-images.service.ts`.
 */
@Entity('form_item_images')
export class FormItemImage {
  /** The media service's object id. */
  @PrimaryColumn('uuid')
  mediaId: string;

  /** The form whose questions may cite it; null until the create page's first save binds it. */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  formId: string | null;

  @Column({ type: 'varchar', length: 255 })
  uploaderId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  @Index()
  createdAt: Date;
}
