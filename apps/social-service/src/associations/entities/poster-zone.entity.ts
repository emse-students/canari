import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

/**
 * A zone of ONE "Carte de la Vie Asso" map (migration 147, owner 2026-11-08): a heading under which
 * the map groups its associations, on the poster and in its directory.
 *
 * Zones belong to the map, not to the platform: each map creates, renames, orders and deletes its
 * own, so two BDEs never edit each other's taxonomy. Deleting a zone leaves its associations on the
 * map, unzoned ({@link PosterEntry.zoneId} goes null).
 */
@Entity('poster_zones')
@Index(['posterProjectId', 'sortOrder'])
export class PosterZone {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The map that owns this zone. */
  @Column({ type: 'uuid' })
  posterProjectId: string;

  /** Heading printed on the poster's directory, e.g. "Culture, Arts". */
  @Column({ type: 'varchar', length: 120 })
  label: string;

  /** Position among the map's zones, ascending. */
  @Column({ type: 'integer', default: 0 })
  sortOrder: number;
}
