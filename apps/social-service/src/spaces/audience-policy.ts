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
  /**
   * A BDE star adding or removing a rule that exceeds the spaces it governs - a whole-campus rule
   * over a campus it shares, say (owner, 2026-11-03: "Lire tout, modifier dans ses espaces"). Such
   * a rule is the platform admin's to widen or remove; the star leaves it as it is.
   */
  RULE_BEYOND_BDE_SPACES: 'AUDIENCE_RULE_BEYOND_BDE_SPACES',
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

/** One key per rule, so two rule sets can be compared as sets. */
function ruleKey(r: RuleLike): string {
  return `${r.formation ?? '*'}|${r.campus ?? '*'}`;
}

/** The rules a write ADDS or REMOVES: the symmetric difference of the two sets. */
export function changedRules(
  current: readonly RuleLike[],
  submitted: readonly RuleLike[]
): RuleLike[] {
  const before = new Set(current.map(ruleKey));
  const after = new Set(submitted.map(ruleKey));
  return [
    ...current.filter((r) => !after.has(ruleKey(r))),
    ...submitted.filter((r) => !before.has(ruleKey(r))),
  ];
}

/**
 * THE BDE STAR'S BOUND: "LIRE TOUT, MODIFIER DANS SES ESPACES" (owner, 2026-11-03).
 *
 * - **Reading** (`assertBdeMayReadAudience`): a star reads the audience of any association or list
 *   of its campus - one with a rule on a campus where it governs a space, or one with no rule.
 * - **Writing** (here): the star must already GOVERN the entity (`governsEntity`, the management
 *   predicate `holdsBdeFlagOverSql` at MANAGE_ASSO - never an institution, never another BDE), so it
 *   cannot take an entity over by adding its own space to it. Then every rule the write ADDS or
 *   REMOVES must lie inside the spaces it governs (`ruleInsideGovernedSpaces`). A rule already in
 *   force that exceeds them - a whole-campus rule over a campus two BDEs share - is left as it is:
 *   the star can neither remove nor widen it (`AUDIENCE_RULE_BEYOND_BDE_SPACES`); that is the
 *   platform admin's.
 */
export function assertBdeMayWriteAudience(
  type: string,
  spaces: readonly SpaceStanding[],
  governsEntity: boolean,
  current: readonly RuleLike[],
  submitted: readonly RuleLike[]
): void {
  assertBdeMayReadAudience(type, spaces, current);
  if (!governsEntity) throw outsideBdeCampus();
  const beyond = changedRules(current, submitted).filter(
    (r) => !ruleInsideGovernedSpaces(r, spaces)
  );
  if (beyond.length > 0) {
    throw new ForbiddenException({
      code: AUDIENCE_ERROR.RULE_BEYOND_BDE_SPACES,
      message:
        "A BDE adds or removes rules inside its own spaces only; a wider rule is the platform admin's.",
    });
  }
}

/** Is `r` on a campus where the star governs at least one space? */
function ruleOnGovernedCampus(r: RuleLike, spaces: readonly SpaceStanding[]): boolean {
  return r.campus !== null && spaces.some((s) => s.governed && s.campus === r.campus);
}

/**
 * The BDE star's READ bound ("Lire tout", owner 2026-11-03): any association or list of its campus,
 * whether or not its rules exceed the star's spaces - the editor shows those rules read-only. An
 * institution stays the platform admin's; a reader governing no space is no star.
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
  if (current.length > 0 && !current.some((r) => ruleOnGovernedCampus(r, spaces))) {
    throw outsideBdeCampus();
  }
}

function outsideBdeCampus(): ForbiddenException {
  return new ForbiddenException({
    code: AUDIENCE_ERROR.OUTSIDE_BDE_CAMPUS,
    message: 'A BDE sets the audience of the associations and lists it governs only.',
  });
}
