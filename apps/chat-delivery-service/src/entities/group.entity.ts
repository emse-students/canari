import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('dm_groups')
export class Group {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  name?: string;

  @Column({ default: false })
  isGroup: boolean;

  @Column({ default: 1 })
  keyVersion: number;

  @Column({ default: 0 })
  activeEpoch: number;

  /** Verrou optimiste pour le re-bootstrap concurrent.
   *  Incrémenté atomiquement par claim-bootstrap. Le premier device qui réussit gagne.
   *  Les autres reçoivent 409 Conflict. */
  @Column({ default: 0 })
  bootstrapVersion: number;

  @Column({ type: 'jsonb', nullable: true })
  latestKeyRotationPayload: any;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
