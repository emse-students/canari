import { BadRequestException } from '@nestjs/common';
import { SPACE_CAMPUSES, SPACE_FORMATIONS } from '../spaces/space.entity';
import type { SpaceCampus, SpaceFormation } from '../spaces/space.entity';

/**
 * What `GET /api/associations` lists (D37, docs/wiki/profiles-and-access.md):
 * - `directory` (the default): the associations whose rules reach one of the reader's spaces, plus
 *   those the reader belongs to. Relevance, not confidentiality - a hidden association's page stays
 *   reachable by its link.
 * - `all`: the whole catalogue, for the screens that PICK an association rather than browse them
 *   (a co-organiser, a list's parent, a payment delegation, a past role, the admin pages).
 */
export type DirectoryScope = 'directory' | 'all';

/** The parsed query of the association listing. `null` on a filter side is "not filtered". */
export interface DirectoryQuery {
  type?: 'association' | 'list';
  scope: DirectoryScope;
  campus: SpaceCampus | null;
  formation: SpaceFormation | null;
}

/** The raw query strings, as the controller receives them. */
export interface RawDirectoryQuery {
  type?: string;
  scope?: string;
  campus?: string;
  formation?: string;
}

/**
 * Parses the listing's query. `type` keeps its historical leniency (an unknown value lists both);
 * `scope`, `campus` and `formation` are new and REFUSE an unknown value with a 400, so a typo never
 * silently widens or empties the answer.
 */
export function parseDirectoryQuery(raw: RawDirectoryQuery): DirectoryQuery {
  const type = raw.type === 'association' || raw.type === 'list' ? raw.type : undefined;
  const scope = raw.scope?.trim() || 'directory';
  if (scope !== 'directory' && scope !== 'all') {
    throw new BadRequestException(`Unknown scope: ${scope}`);
  }
  const { campus, formation } = parseSpaceSelection(raw);
  return { type, scope, campus, formation };
}

/** A selection of spaces: one campus, one formation, or the pair. `null` is "any". */
export interface SpaceSelection {
  campus: SpaceCampus | null;
  formation: SpaceFormation | null;
}

/**
 * Parses `?campus=` / `?formation=` (D4/D6 values), shared by the directory's map filter and the
 * anonymous agenda's selection (D40). An unknown value is a 400: a feed URL is saved once by a
 * calendar app, so a typo must fail where it is typed and never silently widen or empty it.
 */
export function parseSpaceSelection(raw: { campus?: string; formation?: string }): SpaceSelection {
  const campus = raw.campus?.trim() || null;
  if (campus !== null && !(SPACE_CAMPUSES as readonly string[]).includes(campus)) {
    throw new BadRequestException(`Unknown campus: ${campus}`);
  }
  const formation = raw.formation?.trim() || null;
  if (formation !== null && !(SPACE_FORMATIONS as readonly string[]).includes(formation)) {
    throw new BadRequestException(`Unknown formation: ${formation}`);
  }
  return { campus: campus as SpaceCampus | null, formation: formation as SpaceFormation | null };
}
