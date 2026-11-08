import { BadRequestException } from '@nestjs/common';
import { bdeStandingInSpaceSql, governorIsAnAssociationSql } from '../spaces/bde';
import { ruleReachesSpaceSql } from '../spaces/rule-sql';
import {
  SPACE_CAMPUSES,
  SPACE_FORMATIONS,
  type SpaceCampus,
  type SpaceFormation,
} from '../spaces/space.entity';

/**
 * WHO MAY TOUCH WHICH "CARTE DE LA VIE ASSO", AND WHAT A MAP MAY SHOW (owner, 2026-11-08).
 *
 * A map belongs to ONE space. Its managers are the holders of `MANAGE_ASSO` in the association that
 * governs that space - the per-space standing every BDE power bounded by spaces reads
 * (`bdeStandingInSpaceSql`), restricted to a governor of type `association` as every MANAGEMENT
 * reading of a space's governor is (`governorIsAnAssociationSql`: an institution governing a space
 * answers for its agenda, it manages nothing). The platform admin reaches every map. A manager is
 * never shown another BDE's map: an unmanaged map answers 404, the codebase's answer when the
 * existence of the thing is what must not leak.
 *
 * docs/wiki/carte-vie-asso.md, "A carte belongs to one space".
 */

/** Typed refusals of the carte routes; a client tells them apart by `code`, never by message. */
export const CARTE_ERROR = {
  /** A map created without naming the space it is drawn for. */
  SPACE_REQUIRED: 'CARTE_SPACE_REQUIRED',
  /** A map that already belongs to a space was asked to move to another. */
  ALREADY_ATTACHED: 'CARTE_ALREADY_ATTACHED',
  /** A map with no space was asked to go live: a live map always names its space. */
  NOT_ATTACHED: 'CARTE_NOT_ATTACHED',
  /** A published unit names an association the map does not show (switched off, or outside its space). */
  UNIT_OUTSIDE_MAP: 'CARTE_UNIT_OUTSIDE_MAP',
  /** A zone id that is not one of this map's zones. */
  ZONE_UNKNOWN: 'CARTE_ZONE_UNKNOWN',
  /** A switch written for an association that is not of the map's space. */
  ASSOCIATION_OUTSIDE_SPACE: 'CARTE_ASSOCIATION_OUTSIDE_SPACE',
  /** A reorder that does not name every zone of the map exactly once. */
  ZONE_ORDER_INCOMPLETE: 'CARTE_ZONE_ORDER_INCOMPLETE',
  /** `GET /api/public/carte?space=` with a value that names no possible space. */
  PUBLIC_SPACE_INVALID: 'CARTE_PUBLIC_SPACE_INVALID',
  /** `GET /api/public/carte` with no `space` while not exactly one map is live. */
  PUBLIC_SPACE_REQUIRED: 'CARTE_PUBLIC_SPACE_REQUIRED',
} as const;

/** Who asks: the platform admin reaches every map, anyone else only the maps of spaces they manage. */
export interface CarteCaller {
  userId: string;
  isGlobalAdmin: boolean;
}

/**
 * The spaces whose maps user `$1` manages: those governed by an association in which they hold flag
 * `$2` (MANAGE_ASSO). Answers `id`, `formation`, `campus`, ordered as the spaces page lists them.
 */
export const MANAGED_CARTE_SPACES_SQL = `SELECT cs.id, cs.formation, cs.campus FROM spaces cs
  WHERE EXISTS (SELECT 1 FROM association_members cm
    WHERE ${bdeStandingInSpaceSql('cm', 'cs', '$1', '$2')}
      AND ${governorIsAnAssociationSql('cm."associationId"')})
  ORDER BY cs.campus, cs.formation`;

/** Every space, for the platform admin. Same columns and order as {@link MANAGED_CARTE_SPACES_SQL}. */
export const ALL_CARTE_SPACES_SQL = `SELECT cs.id, cs.formation, cs.campus FROM spaces cs
  ORDER BY cs.campus, cs.formation`;

/**
 * THE ASSOCIATIONS OF SPACE `$1` A MAP OFFERS: every association of type `association`, not
 * archived, one of whose audience rules reaches the space - "who addresses this space", the same
 * reading every per-space surface makes (`ruleReachesSpaceSql`). Answers `id`.
 *
 * The audience, not the governing parent: a BDE governs several spaces (production: one association
 * governs four), so its children say nothing about WHICH space a map is drawn for, while the audience
 * says exactly who reaches it.
 */
export const CARTE_SPACE_ASSOCIATIONS_SQL = `SELECT ca.id FROM associations ca
  WHERE ca.type = 'association' AND NOT ca.archived
    AND EXISTS (SELECT 1 FROM association_audiences car JOIN spaces cas ON cas.id = $1
      WHERE car."associationId" = ca.id AND ${ruleReachesSpaceSql('car', 'cas')})
  ORDER BY ca.id`;

/** A space named in a public URL: its natural key, the pair the anonymous agenda selects by. */
export interface CarteSpaceKey {
  formation: SpaceFormation;
  campus: SpaceCampus;
}

/**
 * Reads the `space` parameter of `GET /api/public/carte`: `<formation>:<campus>`, exactly as the
 * spaces table stores them (`ICM:saint-etienne`).
 *
 * THE NATURAL KEY, NOT THE UUID: spaces expose nothing publicly except the formation and campus the
 * anonymous agenda already selects by, and the pair is the same on every estate - so the showcase's
 * configuration names its space once, in words, rather than a row id that differs between production
 * and dev.
 *
 * @returns The pair, or null when the parameter is absent or empty (the legacy path decides).
 * @throws BadRequestException `CARTE_PUBLIC_SPACE_INVALID` for anything else: an array (a repeated
 *   parameter), a value without one `:`, or a formation or campus no space can carry.
 */
export function parseCarteSpaceParam(raw: unknown): CarteSpaceKey | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const invalid = () =>
    new BadRequestException({
      code: CARTE_ERROR.PUBLIC_SPACE_INVALID,
      message: 'space must be <formation>:<campus>, e.g. ICM:saint-etienne',
    });
  if (typeof raw !== 'string') throw invalid();
  const parts = raw.split(':');
  if (parts.length !== 2) throw invalid();
  const [formation, campus] = parts;
  if (!(SPACE_FORMATIONS as readonly string[]).includes(formation)) throw invalid();
  if (!(SPACE_CAMPUSES as readonly string[]).includes(campus)) throw invalid();
  return { formation: formation as SpaceFormation, campus: campus as SpaceCampus };
}
