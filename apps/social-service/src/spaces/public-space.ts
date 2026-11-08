import { BadRequestException, Logger } from '@nestjs/common';
import { ruleReachesSpaceSql } from './rule-sql';
import {
  SPACE_CAMPUSES,
  SPACE_FORMATIONS,
  type SpaceCampus,
  type SpaceFormation,
} from './space.entity';

/**
 * A SPACE NAMED BY AN ANONYMOUS CONSUMER, AND THE ASSOCIATIONS IT OFFERS (owner, 2026-11-08).
 *
 * The portail-etu showcase is the portail of ONE space (`ICM:saint-etienne` in production) and names
 * it in its own configuration; Canari hard-codes no space. Two public reads take that name - the
 * live carte (`GET /api/public/carte?space=`) and the association directory
 * (`GET /api/public/associations?space=`, `.../slug/:slug?space=`) - and both answer with THE SAME
 * set of associations, defined once here ({@link offeredAssociationsSql}).
 *
 * docs/wiki/carte-vie-asso.md ("A carte belongs to one space") and docs/wiki/anonymous-surface.md.
 */

/** The typed refusal of a `space` parameter that names no possible space. */
export const PUBLIC_SPACE_INVALID = 'PUBLIC_SPACE_INVALID';

/** A space named in a public URL: its natural key, the pair the anonymous agenda selects by. */
export interface PublicSpaceKey {
  formation: SpaceFormation;
  campus: SpaceCampus;
}

/**
 * THE ASSOCIATIONS A SPACE OFFERS: every association of type `association`, not archived, one of
 * whose audience rules reaches the space - "who addresses this space", the same reading every
 * per-space surface makes (`ruleReachesSpaceSql`). Answers `id`, ordered by id.
 *
 * The audience, not the governing parent: a BDE governs several spaces (production: one association
 * governs four), so its children say nothing about WHICH space is meant, while the audience says
 * exactly who reaches it.
 *
 * @param spaceMatch - The condition selecting the ONE space on alias `cas` - `cas.id = $1` for a
 *   map's space, `cas.formation = $1 AND cas.campus = $2` for a space named in a public URL. Always a
 *   literal written in this codebase, never user input.
 */
export function offeredAssociationsSql(spaceMatch: string): string {
  return `SELECT ca.id FROM associations ca
  WHERE ca.type = 'association' AND NOT ca.archived
    AND EXISTS (SELECT 1 FROM association_audiences car JOIN spaces cas ON ${spaceMatch}
      WHERE car."associationId" = ca.id AND ${ruleReachesSpaceSql('car', 'cas')})
  ORDER BY ca.id`;
}

/** {@link offeredAssociationsSql} for a space named by its natural key: `$1` formation, `$2` campus. */
export const OFFERED_BY_SPACE_KEY_SQL = offeredAssociationsSql(
  'cas.formation = $1 AND cas.campus = $2'
);

/**
 * Reads a public `space` parameter: `<formation>:<campus>`, exactly as the spaces table stores them
 * (`ICM:saint-etienne`).
 *
 * THE NATURAL KEY, NOT THE UUID: spaces expose nothing publicly except the formation and campus the
 * anonymous agenda already selects by, and the pair is the same on every estate - so a consumer's
 * configuration names its space once, in words, rather than a row id that differs between production
 * and dev.
 *
 * @param raw - The query value as Express parsed it.
 * @param route - Names the route in the refusal's log line.
 * @returns The pair, or null when the parameter is absent or empty (the route decides what that means).
 * @throws BadRequestException `PUBLIC_SPACE_INVALID` for anything else: an array (a repeated
 *   parameter), a value without one `:`, or a formation or campus no space can carry. Logged at WARN
 *   with the value's SHAPE only - it is public input.
 */
export function parsePublicSpaceParam(raw: unknown, route: string): PublicSpaceKey | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const invalid = () => {
    const shape =
      typeof raw === 'string'
        ? `string of ${raw.length} chars, ${raw.split(':').length - 1} colon(s)`
        : Array.isArray(raw)
          ? `array of ${raw.length}`
          : typeof raw;
    new Logger('PublicSpace').warn(`[PUBLIC] ${route} refused: malformed space (${shape})`);
    return new BadRequestException({
      code: PUBLIC_SPACE_INVALID,
      message: 'space must be <formation>:<campus>, e.g. ICM:saint-etienne',
    });
  };
  if (typeof raw !== 'string') throw invalid();
  const parts = raw.split(':');
  if (parts.length !== 2) throw invalid();
  const [formation, campus] = parts;
  if (!(SPACE_FORMATIONS as readonly string[]).includes(formation)) throw invalid();
  if (!(SPACE_CAMPUSES as readonly string[]).includes(campus)) throw invalid();
  return { formation: formation as SpaceFormation, campus: campus as SpaceCampus };
}
