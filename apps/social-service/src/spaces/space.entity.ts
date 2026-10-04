import { Entity, Column, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** The formations a space may be about (D4). Mirrors the MiConnect profile. */
export const SPACE_FORMATIONS = ['ICM', 'ISMIN', 'FSSS', 'Autre'] as const;
/** The campuses a space may be about (D6). Mirrors the MiConnect profile. */
export const SPACE_CAMPUSES = ['saint-etienne', 'gardanne'] as const;

export type SpaceFormation = (typeof SPACE_FORMATIONS)[number];
export type SpaceCampus = (typeof SPACE_CAMPUSES)[number];

/**
 * A formation x campus pair (D16). It exists only once an admin opens it (D17) and is governed by at
 * most one BDE association (D22). What a reader sees is the union of the spaces their cursus and
 * campus open (6b).
 */
@Entity('spaces')
@Unique(['formation', 'campus'])
export class Space {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16 })
  formation: SpaceFormation;

  @Column({ type: 'varchar', length: 32 })
  campus: SpaceCampus;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  openedAt: Date;

  /** The association that governs this space; null until an admin designates it. */
  @Column({ type: 'uuid', nullable: true })
  bdeAssociationId: string | null;
}
