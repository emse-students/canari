import { ruleReachesSpaceSql } from './rule-sql';

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
 * Decided by the user (profiles-and-access, 6c): VALIDATE_EVENTS and MANAGE_ASSO are read through
 * this; MODERATE stays global and does not.
 */
export function holdsBdeFlagOverSql(user: string, association: string, flag: string): string {
  return `EXISTS (SELECT 1 FROM association_members bde_member
    JOIN spaces bde_governed ON bde_governed."bdeAssociationId" = bde_member."associationId"
    JOIN association_audiences bde_reach ON bde_reach."associationId" = ${association}
    WHERE bde_member."userId" = ${user} AND (bde_member.permissions & ${flag}) <> 0
      AND ${ruleReachesSpaceSql('bde_reach', 'bde_governed')})`;
}

/**
 * The campuses of the spaces whose BDE user `$1` holds flag `$2` in - the borders of a BDE star's
 * audience powers (decision 7 of the audiences chantier). Answers `campus`.
 */
export const BDE_GOVERNED_CAMPUSES_SQL = `SELECT DISTINCT bde_space.campus FROM association_members bde_star
  JOIN spaces bde_space ON bde_space."bdeAssociationId" = bde_star."associationId"
  WHERE bde_star."userId" = $1 AND (bde_star.permissions & $2) <> 0 ORDER BY bde_space.campus`;

/** Does user `$1` hold flag `$3` in a BDE governing association `$2`? Answers `holds`. */
export const HOLDS_BDE_FLAG_OVER_SQL = `SELECT ${holdsBdeFlagOverSql('$1', '$2', '$3')} AS "holds"`;

/** The ids of every association whose BDE grants user `$1` flag `$2`. */
export const ASSOCIATIONS_UNDER_BDE_FLAG_SQL = `SELECT gov_asso.id FROM associations gov_asso
  WHERE ${holdsBdeFlagOverSql('$1', 'gov_asso.id', '$2')} ORDER BY gov_asso.id`;

/** Every user holding flag `$2` in a BDE governing association `$1` - who is told, and who may act. */
export const BDE_FLAG_HOLDERS_OVER_SQL = `SELECT DISTINCT bde_holder."userId" FROM association_members bde_holder
  WHERE ${holdsBdeFlagOverSql('bde_holder."userId"', '$1', '$2')} ORDER BY bde_holder."userId"`;
