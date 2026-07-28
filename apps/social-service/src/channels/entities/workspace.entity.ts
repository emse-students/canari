import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

/** TypeORM entity representing a channel workspace (tenant grouping channels and members). */
@Entity('channel_workspaces')
export class Workspace {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  slug: string;

  @Column()
  name: string;

  @Column({ type: 'varchar', length: 255 })
  createdBy: string;

  @Column({ nullable: true, type: 'varchar' })
  imageMediaId: string | null;

  /**
   * Soft-delete tombstone. Every read path filters it out, so an archived workspace is
   * invisible to members, invites and slug lookups while its row keeps the slug reserved
   * and its data recoverable.
   */
  @Column({ default: false })
  archived: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
