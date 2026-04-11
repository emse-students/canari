import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

@Entity('channel_workspaces')
export class Workspace {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  slug: string;

  @Column()
  name: string;

  @Column()
  createdBy: string;

  @Column({ nullable: true, type: 'varchar' })
  imageMediaId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
