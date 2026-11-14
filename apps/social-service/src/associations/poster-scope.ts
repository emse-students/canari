import { bdeStandingInSpaceSql, governorIsAnAssociationSql } from '../spaces/bde';
import { offeredAssociationsSql, type PublicSpaceKey } from '../spaces/public-space';

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
 * THE ASSOCIATIONS OF SPACE `$1` A MAP OFFERS - the one definition every per-space public read shares
 * ({@link offeredAssociationsSql}), here for a space named by its id. Answers `id`.
 */
export const CARTE_SPACE_ASSOCIATIONS_SQL = offeredAssociationsSql(
  'cas.id = $1',
  'active',
  'associations'
);

/** A space named in a public URL (see `spaces/public-space.ts`). */
export type CarteSpaceKey = PublicSpaceKey;
