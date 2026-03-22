import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Unique,
} from 'typeorm';

@Entity()
@Unique(['userId'])
export class PinVerifier {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @Column()
  verifier: string;

  @CreateDateColumn()
  registeredAt: Date;
}
