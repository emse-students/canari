import { Entity, Column, PrimaryColumn, Index } from 'typeorm';

/**
 * One association as ONE map has seen it (migration 147, owner 2026-11-08): its on/off switch and
 * its zone.
 *
 * THE ROW'S EXISTENCE IS ITSELF THE FACT "THIS MAP HAS SEEN THIS ASSOCIATION". An association of the
 * map's space with no row is NEW - created, or given an audience reaching the space, after the map
 * last looked: it is offered switched OFF with a "Nouvelle" badge, and it never reaches the live map
 * until its switch is turned on. Writing the row (on or off) is what retires the badge, so the
 * question is answered by durable state and never by comparing a creation date with a clock.
 */
@Entity('poster_entries')
export class PosterEntry {
  @PrimaryColumn({ type: 'uuid' })
  posterProjectId: string;

  @PrimaryColumn({ type: 'uuid' })
  associationId: string;

  /** Whether the association is drawn on this map (and so may be published). */
  @Column({ type: 'boolean' })
  enabled: boolean;

  /** The zone of THIS map it is placed in; null when unzoned. */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  zoneId: string | null;
}
