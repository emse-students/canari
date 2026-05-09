import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index, Unique } from 'typeorm';

export enum AssociationPermission {
  Member,
  Admin,
}

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

  @Column({ type: 'enum', enum: AssociationPermission, default: AssociationPermission.Member })
  permission: AssociationPermission;

  @CreateDateColumn()
  createdAt: Date;
}
