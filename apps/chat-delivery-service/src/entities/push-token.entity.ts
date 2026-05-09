import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type PushPlatform = 'android' | 'ios';

@Entity()
@Index(['userId', 'deviceId'], { unique: true })
export class PushToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @Column()
  deviceId: string;

  @Column()
  token: string;

  @Column({ type: 'varchar', length: 10 })
  platform: PushPlatform;

  /**
   * Secret opaque (UUID v4) généré à l'enregistrement et retourné UNE SEULE FOIS
   * au client. Le client Android le stocke chiffré dans le Keystore.
   * Utilisé pour authentifier GET /api/mls/push/fetch-proto sans JWT.
   * La valeur en base est le secret brut — la table n'est pas publique et est
   * accessible uniquement par le service. NULL pour les tokens antérieurs.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  pushSecret: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
