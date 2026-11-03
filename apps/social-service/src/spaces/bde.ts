import { ruleReachesSpaceSql } from './rule-sql';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';

/**
 * Is association `alias` the BDE of at least one space?
 *
 * THE ONE DEFINITION OF "A BDE" (WP6c). It used to be a boolean column an admin ticked, which could
 * disagree with the spaces page that designates each space's BDE; now the spaces are the only
 * truth and an association is a BDE exactly when `spaces."bdeAssociationId"` names it.
 *
 * It answers "is a BDE SOMEWHERE", which is what the doors of the BDE surfaces ask (the moderation
 * queue opens to a MODERATE holder anywhere, then narrows to its scope) and what the routes naming no
 * association ask. A power exercised ON an association asks
 * `holdsBdeFlagOverSql` instead, which is scoped to the spaces that association reaches.
 */
export function isBdeAssociationSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM spaces bde_space WHERE bde_space."bdeAssociationId" = ${alias}.id)`;
}

/**
 * THE SCOPED BDE PREDICATE (WP6c step 2): user `user` holds `flag` in the BDE of a space that
 * association `association` reaches.
 *
 * Every argument is a SQL expression (a placeholder like `$1`, or a column like `e."associationId"`),
 * so the same text filters a list, answers one question, or picks recipients.
 *
 * "The spaces an association reaches" are the spaces its `association_audiences` rules reach - the
 * same rules the readers are resolved from (`reader-spaces.ts`), so the BDE that governs an
 * association is the BDE of the people it addresses. An association reaching SEVERAL spaces is
 * governed by the BDE of ANY of them; one reaching NO space (no rule) is governed by nobody here,
 * which leaves it to a global admin. A BDE always reaches the spaces it governs (the spaces page
 * holds that), so a BDE governs its own association.
 *
 * Decided by the user (profiles-and-access, 6c): MANAGE_ASSO is read through this, and VALIDATE_EVENTS
 * through its agenda twin below. MODERATE is read through this too since 2026-11-02 (owner), by
 * `bde-moderation.ts` for content in an association's name - so an institution's content is the
 * platform admin's to moderate, as its management is - which adds the personal content and the
 * people this predicate cannot express, on the same per-space standing (`bdeStandingInSpaceSql`).
 *
 * AN INSTITUTION HAS NO GOVERNING BDE, EVER (owner, 2026-11-02: "une institution n'a personne au
 * dessus"; 2026-11-03: "Aucun BDE n'a les droits de gestion sur une institution"). Its audience may
 * reach a BDE's space, and that must confer no MANAGEMENT: no super-admin tier (archive, members,
 * profile, audience, delete). Only its own members, within their flags, and the platform admin
 * manage it. Written HERE, once, so every management caller - `mayAct`, `mayActOnAny`, the delete
 * route - inherits it.
 *
 * A BDE IS MANAGED BY NOBODY BUT ITSELF (owner, 2026-11-03: "Un BDE n'est géré par personne"). One
 * campus holds two BDEs, and one BDE's whole-campus rule reaches the other's spaces, so the space
 * rule alone made each BDE the super-admin of the other - uncapped, it could seat itself there. A
 * target that is the BDE of any space is therefore managed only through a membership in THAT BDE.
 *
 * THE AGENDA IS NOT MANAGEMENT. "c'est le BDE qui a tous les droits sur l'agenda des formations dont
 * il est le BDE" (owner, 2026-11-03): validating, rejecting and every other agenda right follow the
 * spaces an event TARGETS, whoever organises it - an institution's event included. That is
 * `holdsBdeAgendaRightOverSql`, the same space rule without the management exclusions.
 */
export function holdsBdeFlagOverSql(user: string, association: string, flag: string): string {
  return bdeFlagOverReachSql(user, association, flag, true);
}

/**
 * THE AGENDA PREDICATE (owner, 2026-11-03): user `user` holds `VALIDATE_EVENTS` in the BDE of a
 * space the events of association `association` target - and so validates, rejects, edits, deposits
 * on and declares a break for them. Until per-event targeting (WP-E) an event targets the spaces its
 * organiser's audience rules reach, so this is the scoped rule of `holdsBdeFlagOverSql` read for
 * the agenda: an INSTITUTION's event is validated by the BDE of the spaces it targets (or the
 * platform admin), even though no BDE manages the institution itself. The flag is fixed here, so
 * no caller can lift the institution exclusion for a management right through this door.
 */
export function holdsBdeAgendaRightOverSql(user: string, association: string): string {
  return bdeFlagOverReachSql(
    user,
    association,
    String(AssociationPermissionFlag.VALIDATE_EVENTS),
    false
  );
}

/**
 * The space rule both predicates share. `management` adds the two exclusions of management - an
 * institution, and another BDE - which the agenda does not have.
 */
function bdeFlagOverReachSql(
  user: string,
  association: string,
  flag: string,
  management: boolean
): string {
  const target = management
    ? `
    JOIN associations bde_target ON bde_target.id = ${association}`
    : '';
  const notInstitution = management
    ? `
      AND bde_target.type <> 'institution'
      AND (bde_member."associationId" = bde_target.id OR NOT EXISTS (SELECT 1 FROM spaces bde_of_target
        WHERE bde_of_target."bdeAssociationId" = bde_target.id))`
    : '';
  return `EXISTS (SELECT 1 FROM association_members bde_member
    JOIN spaces bde_governed ON ${bdeStandingInSpaceSql('bde_member', 'bde_governed', user, flag)}
    JOIN association_audiences bde_reach ON bde_reach."associationId" = ${association}${target}
    WHERE TRUE${notInstitution}
      AND ${ruleReachesSpaceSql('bde_reach', 'bde_governed')})`;
}

/**
 * THE PER-SPACE STANDING, ONE STATEMENT: membership row `member` is user `user`'s in the BDE that
 * governs space `space`, and holds `flag` there. Every BDE power bounded by spaces reads it - the
 * management and agenda predicates above, the standings list below, and MODERATE's reach over people
 * (`bde-moderation.ts`) - so "governs this space" cannot mean two things. All four arguments are SQL
 * expressions (aliases, placeholders or columns).
 */
export function bdeStandingInSpaceSql(
  member: string,
  space: string,
  user: string,
  flag: string
): string {
  return `${space}."bdeAssociationId" = ${member}."associationId"
      AND ${member}."userId" = ${user} AND (${member}.permissions & ${flag}) <> 0`;
}

/**
 * Every opened space, with whether a BDE in which user `$1` holds flag `$2` governs it. Answers
 * `formation`, `campus`, `governed`. The borders of a BDE star's audience powers PER SPACE
 * (`audience-policy.ts` `ruleInsideGovernedSpaces`), and of a creator's default audience
 * (`creatorDefaultRules`). A campus-level bound let a star write over a space another BDE of the
 * same campus governs.
 */
export const BDE_SPACE_STANDINGS_SQL = `SELECT bde_space.formation, bde_space.campus,
    EXISTS (SELECT 1 FROM association_members bde_star
      WHERE ${bdeStandingInSpaceSql('bde_star', 'bde_space', '$1', '$2')}) AS "governed"
  FROM spaces bde_space ORDER BY bde_space.campus, bde_space.formation`;

/** Does user `$1` hold flag `$3` in a BDE governing association `$2`? Answers `holds`. */
export const HOLDS_BDE_FLAG_OVER_SQL = `SELECT ${holdsBdeFlagOverSql('$1', '$2', '$3')} AS "holds"`;

/** The ids of every association whose BDE grants user `$1` flag `$2`. */
export const ASSOCIATIONS_UNDER_BDE_FLAG_SQL = `SELECT gov_asso.id FROM associations gov_asso
  WHERE ${holdsBdeFlagOverSql('$1', 'gov_asso.id', '$2')} ORDER BY gov_asso.id`;

/** Does user `$1` hold the agenda right over the events of association `$2`? Answers `holds`. */
export const HOLDS_BDE_AGENDA_RIGHT_OVER_SQL = `SELECT ${holdsBdeAgendaRightOverSql('$1', '$2')} AS "holds"`;

/** The ids of every association whose events user `$1` holds the BDE agenda right over. */
export const ASSOCIATIONS_UNDER_BDE_AGENDA_RIGHT_SQL = `SELECT agenda_asso.id FROM associations agenda_asso
  WHERE ${holdsBdeAgendaRightOverSql('$1', 'agenda_asso.id')} ORDER BY agenda_asso.id`;

/** Every user holding the BDE agenda right over the events of association `$1` - who is told. */
export const BDE_AGENDA_RIGHT_HOLDERS_OVER_SQL = `SELECT DISTINCT agenda_holder."userId" FROM association_members agenda_holder
  WHERE ${holdsBdeAgendaRightOverSql('agenda_holder."userId"', '$1')} ORDER BY agenda_holder."userId"`;

/**
 * Does association `$1` target a space NO BDE governs - or no opened space at all? Answers
 * `ungoverned`. For that slice of its audience the platform admin is the only validator, so a
 * proposal of it is told to the platform admins too (`notifyEventValidatorsOfProposal`).
 */
export const TARGETS_AN_UNGOVERNED_SPACE_SQL = `SELECT (
    NOT EXISTS (SELECT 1 FROM association_audiences t_rule
      JOIN spaces t_space ON ${ruleReachesSpaceSql('t_rule', 't_space')}
      WHERE t_rule."associationId" = $1)
    OR EXISTS (SELECT 1 FROM association_audiences t_rule
      JOIN spaces t_space ON ${ruleReachesSpaceSql('t_rule', 't_space')}
      WHERE t_rule."associationId" = $1 AND t_space."bdeAssociationId" IS NULL)
  ) AS "ungoverned"`;

/**
 * Every platform administrator. `users.admin` is core-service's column (the flag its sign-in signs
 * into the access token); this service reads the shared `users` table as it does for names and
 * campuses, and never writes it.
 */
export const PLATFORM_ADMINS_SQL = `SELECT plat_admin.id AS "userId" FROM users plat_admin
  WHERE plat_admin.admin = true ORDER BY plat_admin.id`;
