import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Singleton row (id=1) holding platform-wide settings toggled by global admins. */
@Entity('platform_config')
export class PlatformConfig {
  @PrimaryColumn({ type: 'int', default: 1 })
  id!: number;

  /** When true, only global admins may authenticate and use authenticated APIs. */
  @Column({ name: 'maintenance_enabled', type: 'boolean', default: false })
  maintenanceEnabled!: boolean;

  /** Optional message shown to users blocked by maintenance mode. */
  @Column({ name: 'maintenance_message', type: 'text', nullable: true })
  maintenanceMessage!: string | null;

  /** Minimum client semver required before MLS unlock (major.minor.patch). */
  @Column({
    name: 'min_client_version',
    type: 'varchar',
    length: 32,
    default: '0.0.0',
  })
  minClientVersion!: string;
}
