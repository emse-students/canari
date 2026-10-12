import { BadRequestException } from '@nestjs/common';
import { assertAgendaSignature } from './agenda-signature';
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
  type?: 'association' | 'list' | 'institution';
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
  const type =
    raw.type === 'association' || raw.type === 'list' || raw.type === 'institution'
      ? raw.type
      : undefined;
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

/** The code of the 400 an anonymous agenda read gets when it names no selection (D40). */
export const AGENDA_SELECTION_REQUIRED = 'AGENDA_SELECTION_REQUIRED';

/**
 * THE PUBLIC AGENDA IS ONE SIGNED FEED PER SELECTION (D40, amended 2026-10-06). An ANONYMOUS read
 * must name a campus / formation / association (`campus`, `formation`, `associationId`) AND carry
 * the `sig` the server signed for that selection, or name one event (`eventId`, the single-evening
 * link, readable unsigned like an SEO page). No selection and no event is a 400
 * `AGENDA_SELECTION_REQUIRED` - no fallback to "everything"; an unsigned or wrongly signed
 * selection is a 403 (`agenda-signature.ts`). A signed-in reader is already narrowed to their own
 * spaces, and `trusted` (a server-to-server call with the internal secret, the SEO page) is not
 * restricted: neither is checked.
 */
export function assertAgendaAccess(args: {
  selection: SpaceSelection;
  associationId?: string;
  eventId?: string;
  sig?: string;
  signedIn: boolean;
  trusted?: boolean;
}): void {
  if (args.signedIn || args.trusted) return;
  const associationId = args.associationId?.trim() || null;
  if (args.eventId?.trim()) return;
  if (args.selection.campus === null && args.selection.formation === null && !associationId) {
    throw new BadRequestException({
      code: AGENDA_SELECTION_REQUIRED,
      message:
        'The public agenda needs a selection: pass campus and/or formation (or associationId)',
    });
  }
  assertAgendaSignature({ ...args.selection, associationId }, args.sig);
}
