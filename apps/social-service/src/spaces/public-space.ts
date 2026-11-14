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
 * THE ENTITIES OF A SPACE: every entity one of whose audience rules reaches the space - "who
 * addresses this space", the same reading every per-space surface makes (`ruleReachesSpaceSql`).
 * Answers `id`, ordered by id.
 *
 * WHICH TYPES, AN EXPLICIT CHOICE OF THE READER TOO (owner, 2026-11-14): a carte draws type
 * `association` only (`'associations'`); the portail's directory is filtered for EVERY type
 * (`'every-type'`) - a list or an institution that does not address the space is not of its portail
 * either ("Filtrer comme les assos"). Until that day lists and institutions were served whatever the
 * space, so the portail of one space listed every campus's lists.
 *
 * ARCHIVED, AN EXPLICIT CHOICE OF THE READER (owner, 2026-11-08): a carte offers only the living
 * associations (`'active'`); the portail's directory lists the archived ones of its space too, in its
 * archived section (`'any'`). The space-reach condition is the same for both - one definition.
 *
 * The audience, not the governing parent: a BDE governs several spaces (production: one association
 * governs four), so its children say nothing about WHICH space is meant, while the audience says
 * exactly who reaches it.
 *
 * @param types - `'associations'` for type `association` alone, `'every-type'` for all three.
 * @param spaceMatch - The condition selecting the ONE space on alias `cas` - `cas.id = $1` for a
 *   map's space, `cas.formation = $1 AND cas.campus = $2` for a space named in a public URL. Always a
 *   literal written in this codebase, never user input.
 */
export function offeredAssociationsSql(
  spaceMatch: string,
  archived: 'active' | 'any',
  types: 'associations' | 'every-type'
): string {
  const narrowing = [
    ...(types === 'associations' ? [`ca.type = 'association'`] : []),
    ...(archived === 'active' ? ['NOT ca.archived'] : []),
  ].map((condition) => `${condition} AND `);
  return `SELECT ca.id FROM associations ca
  WHERE ${narrowing.join('')}EXISTS (SELECT 1 FROM association_audiences car JOIN spaces cas ON ${spaceMatch}
      WHERE car."associationId" = ca.id AND ${ruleReachesSpaceSql('car', 'cas')})
  ORDER BY ca.id`;
}

/**
 * {@link offeredAssociationsSql} for a space named by its natural key (`$1` formation, `$2` campus),
 * archived ones INCLUDED (the portail's directory splits active and archived itself) and EVERY type:
 * associations, lists and institutions alike.
 */
export const OFFERED_BY_SPACE_KEY_SQL = offeredAssociationsSql(
  'cas.formation = $1 AND cas.campus = $2',
  'any',
  'every-type'
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
