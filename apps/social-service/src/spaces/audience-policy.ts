import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SPACE_CAMPUSES } from './space.entity';
import type { SpaceCampus } from './space.entity';

/** The pure shape of a rule, kept apart from `spaces.service.ts` so this file imports nothing of it. */
interface RuleLike {
  formation: string | null;
  campus: string | null;
}

/**
 * THE TYPED REFUSALS OF AN AUDIENCE WRITE (WP-A of the audiences chantier, user 2026-10-07).
 * Classified at the throw: a client reads `code`, never the message.
 */
export const AUDIENCE_ERROR = {
  /** An `everyone` (no-campus) rule on anything but an institution (decision 6). */
  EVERYONE_INSTITUTION_ONLY: 'AUDIENCE_EVERYONE_INSTITUTION_ONLY',
  /** The creator has no campus on their profile: the default cannot be computed (decision 5). */
  CREATOR_CAMPUS_REQUIRED: 'AUDIENCE_CREATOR_CAMPUS_REQUIRED',
  /** A BDE star touching an institution (decision 7). */
  INSTITUTION_ADMIN_ONLY: 'AUDIENCE_INSTITUTION_ADMIN_ONLY',
  /**
   * A BDE star touching a space it does not govern, on the entity's current rules or the new ones.
   * The name predates the per-space bound (2026-11-02) and is kept: clients read it.
   */
  OUTSIDE_BDE_CAMPUS: 'AUDIENCE_OUTSIDE_BDE_CAMPUS',
  /** Neither a global admin nor the holder of MANAGE_ASSO in any BDE. */
  ADMIN_OR_BDE_REQUIRED: 'AUDIENCE_ADMIN_OR_BDE_REQUIRED',
} as const;

/**
 * Does the rule reach EVERY campus? A rule with no campus does, whatever its formation: it is the
 * `everyone` of decision 1 (and a formation across campuses is the multi-campus audience decision 3
 * rules out on one entity). Only an institution may hold one.
 */
export function isEveryoneRule(rule: RuleLike): boolean {
  return rule.campus === null;
}

/**
 * Refuses an `everyone` rule on any entity that is not an institution (decision 6). The UI hiding
 * the preset is not the rule: this runs on EVERY audience write, so a hand-written request is
 * refused here.
 */
export function assertAudienceAllowedForType(type: string, rules: readonly RuleLike[]): void {
  if (type === 'institution') return;
  if (rules.some(isEveryoneRule)) {
    throw new BadRequestException({
      code: AUDIENCE_ERROR.EVERYONE_INSTITUTION_ONLY,
      message:
        'Only an institution may address everyone; an association or a list addresses a campus.',
    });
  }
}

/**
 * The default audience of a new association or list (decision 2): its creator's campus, every
 * formation (`formation` NULL + campus), editable afterwards. A creator with no valid campus is
 * refused with a typed error (decision 5) - the presets are computed from a campus, never guessed.
 */
export function defaultCampusRules(
  campus: string | null
): { formation: null; campus: SpaceCampus }[] {
  if (!campus || !(SPACE_CAMPUSES as readonly string[]).includes(campus)) {
    throw new BadRequestException({
      code: AUDIENCE_ERROR.CREATOR_CAMPUS_REQUIRED,
      message: 'Complete your profile with a campus before creating an association or a list.',
    });
  }
  return [{ formation: null, campus: campus as SpaceCampus }];
}

/**
 * One opened space as a BDE star sees it: its pair, and whether a BDE in which the star holds
 * MANAGE_ASSO governs it (`BDE_SPACE_STANDINGS_SQL`). Every opened space is listed, governed or
 * not, because a whole-campus rule is judged against all of its campus.
 */
export interface SpaceStanding {
  formation: string;
  campus: string;
  governed: boolean;
}

/**
 * Does `r` stay inside the spaces the star governs? PER SPACE, the granularity governance has
 * (`holdsBdeFlagOverSql`), never per campus (2026-11-02): a (formation, campus) rule is inside when
 * that space is governed; a whole-campus rule only when EVERY opened space of the campus is (one
 * campus may hold two BDEs); an `everyone` rule never. A campus with no opened space is outside.
 */
export function ruleInsideGovernedSpaces(r: RuleLike, spaces: readonly SpaceStanding[]): boolean {
  if (r.campus === null) return false;
  const ofCampus = spaces.filter((s) => s.campus === r.campus);
  if (r.formation === null) return ofCampus.length > 0 && ofCampus.every((s) => s.governed);
  return ofCampus.some((s) => s.formation === r.formation && s.governed);
}

/**
 * The BDE star's bound (decision 7, scoped per SPACE since 2026-11-02): it may write the audience
 * of an association or list it ALREADY governs, and only inside the spaces it governs. Both what the
 * entity addresses NOW and what is submitted must sit inside them, so a star can neither take over
 * an entity another BDE governs (one campus can hold two BDEs) nor push its own beyond its borders.
 * An entity with no rule at all is governed by nobody and stays a global admin's.
 */
export function assertBdeMayWriteAudience(
  type: string,
  spaces: readonly SpaceStanding[],
  current: readonly RuleLike[],
  submitted: readonly RuleLike[]
): void {
  assertBdeMayReadAudience(type, spaces, current);
  if (!submitted.every((r) => ruleInsideGovernedSpaces(r, spaces))) throw outsideBdeCampus();
}

/**
 * The BDE star's READ bound (user, 2026-10-08: "campus de l'etoile seulement", per space since
 * 2026-11-02): it may read the rules of an entity whose CURRENT rules all lie within the spaces it
 * governs - the same bound and codes as the write path, so the editor can preselect what is in
 * force.
 */
export function assertBdeMayReadAudience(
  type: string,
  spaces: readonly SpaceStanding[],
  current: readonly RuleLike[]
): void {
  if (type === 'institution') {
    throw new ForbiddenException({
      code: AUDIENCE_ERROR.INSTITUTION_ADMIN_ONLY,
      message: 'Only a global admin sets the audience of an institution.',
    });
  }
  if (!spaces.some((s) => s.governed)) {
    throw new ForbiddenException({
      code: AUDIENCE_ERROR.ADMIN_OR_BDE_REQUIRED,
      message: 'Global admin or MANAGE_ASSO in a BDE required.',
    });
  }
  if (current.length === 0 || !current.every((r) => ruleInsideGovernedSpaces(r, spaces))) {
    throw outsideBdeCampus();
  }
}

function outsideBdeCampus(): ForbiddenException {
  return new ForbiddenException({
    code: AUDIENCE_ERROR.OUTSIDE_BDE_CAMPUS,
    message: 'A BDE sets the audience of the associations and lists of its own spaces only.',
  });
}

/**
 * A NON-ADMIN creator's default campus must be one their BDE star governs (WP-B, closing the open
 * point of WP-A): otherwise the creator would make an association it could not then edit (decision
 * 7). `governed` are the campuses of the spaces whose BDE the creator holds MANAGE_ASSO in. A global
 * admin never reaches this check.
 */
export function assertCreatorCampusGoverned(
  governed: readonly string[],
  rules: readonly RuleLike[]
): void {
  if (!rules.every((r) => r.campus !== null && governed.includes(r.campus))) {
    throw new ForbiddenException({
      code: AUDIENCE_ERROR.OUTSIDE_BDE_CAMPUS,
      message: 'A BDE creates the associations and lists of its own campus only.',
    });
  }
}
