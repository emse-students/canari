import { ruleReachesSpaceSql } from './rule-sql';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';

/**
 * Is association `alias` the BDE of at least one space?
 *
 * THE ONE DEFINITION OF "A BDE" (WP6c). It used to be a boolean column an admin ticked, which could
 * disagree with the spaces page that designates each space's BDE; now the spaces are the only
 * truth and an association is a BDE exactly when `spaces."bdeAssociationId"` names it.
 *
 * It answers "is a BDE SOMEWHERE", which is what the platform-wide grants ask (MODERATE, D23) and
 * what the routes naming no association ask. A power exercised ON an association asks
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
 * through its agenda twin below; MODERATE stays global and does neither.
 *
 * AN INSTITUTION HAS NO GOVERNING BDE, EVER (owner, 2026-11-02: "une institution n'a personne au
 * dessus"; 2026-11-03: "Aucun BDE n'a les droits de gestion sur une institution"). Its audience may
 * reach a BDE's space, and that must confer no MANAGEMENT: no super-admin tier (archive, members,
 * profile, audience, delete). Only its own members, within their flags, and the platform admin
 * manage it. Written HERE, once, so every management caller - `mayAct`, `mayActOnAny`, the delete
 * route - inherits it.
 *
 * THE AGENDA IS NOT MANAGEMENT. "c'est le BDE qui a tous les droits sur l'agenda des formations dont
 * il est le BDE" (owner, 2026-11-03): validating, rejecting and every other agenda right follow the
 * spaces an event TARGETS, whoever organises it - an institution's event included. That is
 * `holdsBdeAgendaRightOverSql`, the same space rule without the institution exclusion.
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

/** The space rule both predicates share; `excludeInstitution` is the only difference. */
function bdeFlagOverReachSql(
  user: string,
  association: string,
  flag: string,
  excludeInstitution: boolean
): string {
  const target = excludeInstitution
    ? `
    JOIN associations bde_target ON bde_target.id = ${association}`
    : '';
  const notInstitution = excludeInstitution
    ? `
      AND bde_target.type <> 'institution'`
    : '';
  return `EXISTS (SELECT 1 FROM association_members bde_member
    JOIN spaces bde_governed ON bde_governed."bdeAssociationId" = bde_member."associationId"
    JOIN association_audiences bde_reach ON bde_reach."associationId" = ${association}${target}
    WHERE bde_member."userId" = ${user} AND (bde_member.permissions & ${flag}) <> 0${notInstitution}
      AND ${ruleReachesSpaceSql('bde_reach', 'bde_governed')})`;
}

/**
 * The campuses of the spaces whose BDE user `$1` holds flag `$2` in - the borders of a BDE star's
 * audience powers (decision 7 of the audiences chantier). Answers `campus`.
 */
export const BDE_GOVERNED_CAMPUSES_SQL = `SELECT DISTINCT bde_space.campus FROM association_members bde_star
  JOIN spaces bde_space ON bde_space."bdeAssociationId" = bde_star."associationId"
  WHERE bde_star."userId" = $1 AND (bde_star.permissions & $2) <> 0 ORDER BY bde_space.campus`;

/**
 * Every opened space, with whether a BDE in which user `$1` holds flag `$2` governs it. Answers
 * `formation`, `campus`, `governed`. The borders of a BDE star's audience powers PER SPACE
 * (`audience-policy.ts` `ruleInsideGovernedSpaces`): the campus-level `BDE_GOVERNED_CAMPUSES_SQL`
 * let a star write over a space another BDE of the same campus governs.
 */
export const BDE_SPACE_STANDINGS_SQL = `SELECT bde_space.formation, bde_space.campus,
    EXISTS (SELECT 1 FROM association_members bde_star
      WHERE bde_star."associationId" = bde_space."bdeAssociationId"
        AND bde_star."userId" = $1 AND (bde_star.permissions & $2) <> 0) AS "governed"
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
