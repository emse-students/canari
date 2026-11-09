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
 * association ask. A power exercised ON an association asks `holdsBdeFlagOverSql` instead, which
 * names the one BDE that governs that association (its parent, WP-D2).
 */
export function isBdeAssociationSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM spaces bde_space WHERE bde_space."bdeAssociationId" = ${alias}.id)`;
}

/**
 * THE BDE THAT GOVERNS ENTITY `child` (an alias of `associations`), joined as alias `bde`: its
 * governing PARENT (`parentAssociationId`, WP-D2), or the entity ITSELF when it is a BDE - and only
 * when that association is of type `association` and governs at least one space.
 *
 * - **No parent, not a BDE**: nothing joins, so nobody but the platform admin governs it (B2).
 * - **A parent that governs no space**: nothing joins either - a parent left without a space
 *   governs nobody (reform 2.2; the Dependencies panel shows it as a mismatch).
 * - **A BDE** has no parent ("un BDE n'est gere par personne", D2, G10) and is governed through a
 *   membership in ITSELF only - never by another BDE whose audience overlaps it, and never by a
 *   parent a hand-written row gives it: the last clause refuses the parent path for a child that
 *   governs a space, so this does not rest on migration 131's triggers alone.
 * - **An institution** has no parent (the triggers of migration 131 refuse one) and governs itself
 *   as an institution, never as a BDE: the `type` tests exclude both paths even for a hand-written
 *   row, so no BDE ever governs an institution (E5, G9).
 *
 * Two levels (D2) make this ONE join on a primary key, never a recursion.
 */
export function governingBdeJoinSql(child: string, bde: string): string {
  return `JOIN associations ${bde} ON ${bde}.id IN (${child}."parentAssociationId", ${child}.id)
      AND ${bde}.type = 'association' AND ${child}.type <> 'institution'
      AND ${isBdeAssociationSql(bde)}
      AND (${bde}.id = ${child}.id OR NOT ${isBdeAssociationSql(child)})`;
}

/**
 * THE GOVERNANCE PREDICATE (WP-D2, owner 2026-11-07, reform 2.4): user `user` holds `flag` in the
 * BDE that GOVERNS association `association` - its parent, or itself when it is a BDE
 * (`governingBdeJoinSql`).
 *
 * Every argument is a SQL expression (a placeholder like `$1`, or a column like `e."associationId"`),
 * so the same text filters a list, answers one question, or picks recipients.
 *
 * IT USED TO BE READ FROM REACH: the BDE of ANY space the association's audience reached governed it
 * (WP6c step 2). On a campus two BDEs share, a whole-campus rule made BOTH BDEs uncapped super-admins
 * of the entity, and a rule written while one BDE governed every space of a campus handed the entity
 * to another BDE the day the platform admin opened a new space there (reform P1, the WP-R1
 * residual). Governance is now the dependency axis alone: the audience decides who READS, the parent
 * who GOVERNS (D1, "correlated, never coupled") - so an audience edit can neither take an entity over
 * nor hand it away.
 *
 * Read for MANAGE_ASSO (`isAssociationSuperAdminOf`, hence `mayAct`, `mayActOnAny`, the role guard
 * and the delete route - E3: a parent BDE deletes an association or list that depends on it), for
 * MODERATE over content published in an association's name (`bde-moderation.ts`, WP-R4: the parent's
 * moderators moderate their children's posts, comments and lives; G9: no BDE an institution's), for
 * the BDE star's audience writes (`spaces.service.ts`), and for the last-admin bypass of the member
 * routes. A BDE's own officers keep governing the BDE itself, as they did.
 *
 * THE AGENDA IS NOT GOVERNANCE. "c'est le BDE qui a tous les droits sur l'agenda des formations dont
 * il est le BDE" (owner, 2026-11-03): validating and every other agenda right follow the spaces an
 * event TARGETS, whoever organises it - an institution's event included. That is
 * `holdsBdeAgendaRightOverSql`, still read per space until WP-E.
 */
export function holdsBdeFlagOverSql(user: string, association: string, flag: string): string {
  return `EXISTS (SELECT 1 FROM associations gov_child
    ${governingBdeJoinSql('gov_child', 'gov_bde')}
    JOIN association_members gov_m ON gov_m."associationId" = gov_bde.id
    WHERE gov_child.id = ${association}
      AND gov_m."userId" = ${user} AND (gov_m.permissions & ${flag}) <> 0)`;
}

/**
 * THE AGENDA PREDICATE (owner, 2026-11-03): user `user` holds `VALIDATE_EVENTS` in the BDE of a
 * space the events of association `association` target - and so validates, rejects, edits, deposits
 * on and declares a break for them. Until per-event targeting (WP-E) an event targets the spaces its
 * organiser's audience rules reach: an INSTITUTION's event is validated by the BDE of the spaces it
 * targets (or the platform admin), though no BDE governs the institution itself. The flag is fixed
 * here, so no caller can read a management right through this door. It is NOT the governance
 * predicate above and never was: the agenda follows the spaces, governance the parent.
 */
export function holdsBdeAgendaRightOverSql(user: string, association: string): string {
  const flag = String(AssociationPermissionFlag.VALIDATE_EVENTS);
  return `EXISTS (SELECT 1 FROM association_members bde_member
    JOIN spaces bde_governed ON ${bdeStandingInSpaceSql('bde_member', 'bde_governed', user, flag)}
    JOIN association_audiences bde_reach ON bde_reach."associationId" = ${association}
    WHERE ${ruleReachesSpaceSql('bde_reach', 'bde_governed')})`;
}

/**
 * The governor `governor` (a SQL expression naming an association id) is of type `association`.
 *
 * A space's governor may be an INSTITUTION since WP-D1 (owner D3, reform 2.3: a formation with no BDE
 * placed under the School). That governor answers for the space's AGENDA and its students' personal
 * content - the per-space standing below, unchanged - but it is "still not a BDE for D2": it never
 * becomes a parent and MANAGES nothing. So every MANAGEMENT reading of a space's governor (a BDE
 * star's audience read standings, the MANAGE_ASSO door of the routes naming no association) adds
 * this, and only those; the governance predicate tests the same type in `governingBdeJoinSql`.
 */
export function governorIsAnAssociationSql(governor: string): string {
  return `EXISTS (SELECT 1 FROM associations gov_kind WHERE gov_kind.id = ${governor} AND gov_kind.type = 'association')`;
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
 * `formation`, `campus`, `governed`. The READ border of a BDE star's audience powers ("Lire tout",
 * `audience-policy.ts` `assertBdeMayReadAudience`): every BDE the star holds the flag in counts.
 * The WRITE border is narrower - the spaces of the entity's own governing BDE
 * (`ENTITY_GOVERNOR_SPACE_STANDINGS_SQL`). Read only with MANAGE_ASSO, so a space an INSTITUTION
 * governs is never "governed" here (`governorIsAnAssociationSql`).
 */
export const BDE_SPACE_STANDINGS_SQL = `SELECT bde_space.formation, bde_space.campus,
    EXISTS (SELECT 1 FROM association_members bde_star
      WHERE ${bdeStandingInSpaceSql('bde_star', 'bde_space', '$1', '$2')}
        AND ${governorIsAnAssociationSql('bde_star."associationId"')}) AS "governed"
  FROM spaces bde_space ORDER BY bde_space.campus, bde_space.formation`;

/**
 * Every opened space, with whether THE BDE GOVERNING association `$1` (`governingBdeJoinSql`: its
 * parent, or itself when it is a BDE) governs it AND user `$2` holds flag `$3` there. Answers
 * `formation`, `campus`, `governed`.
 *
 * THE WRITE BORDER OF A BDE STAR'S AUDIENCE POWERS (WP-D2, G8 "modifier dans ses espaces", D1 "Oui
 * pour le parent"): a parent writes its child's audience inside the parent's OWN spaces - never
 * inside the spaces of another BDE the same person also holds MANAGE_ASSO in. Every opened space is
 * listed, governed or not, because a whole-campus rule is judged against all of its campus
 * (`ruleInsideGovernedSpaces`).
 */
export const ENTITY_GOVERNOR_SPACE_STANDINGS_SQL = `SELECT eg_space.formation, eg_space.campus,
    EXISTS (SELECT 1 FROM associations eg_child
      ${governingBdeJoinSql('eg_child', 'eg_bde')}
      JOIN association_members eg_m ON eg_m."associationId" = eg_bde.id
      WHERE eg_child.id = $1
        AND ${bdeStandingInSpaceSql('eg_m', 'eg_space', '$2', '$3')}) AS "governed"
  FROM spaces eg_space ORDER BY eg_space.campus, eg_space.formation`;

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

/**
 * The BDEs - associations governing at least one space - in which user `$1` holds flag `$2`. Answers
 * `id`. With MANAGE_ASSO: the parents a non-admin creator may give a new entity (reform 2.5, B1).
 */
export const BDES_WHERE_USER_HOLDS_SQL = `SELECT holder_bde.id FROM associations holder_bde
  JOIN association_members holder_m ON holder_m."associationId" = holder_bde.id
  WHERE holder_m."userId" = $1 AND (holder_m.permissions & $2) <> 0
    AND holder_bde.type = 'association' AND ${isBdeAssociationSql('holder_bde')}
  ORDER BY holder_bde.id`;
