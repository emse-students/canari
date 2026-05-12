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

  @CreateDateColumn()
  createdAt: Date;
}
