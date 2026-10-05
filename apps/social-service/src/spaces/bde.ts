/**
 * Is association `alias` the BDE of at least one space?
 *
 * THE ONE DEFINITION OF "A BDE" (WP6c). It used to be a boolean column an admin ticked, which could
 * disagree with the spaces page that designates each space's BDE; now the spaces are the only
 * truth and an association is a BDE exactly when `spaces."bdeAssociationId"` names it. The BDE-only
 * grants (VALIDATE_EVENTS, MANAGE_ASSO, MODERATE) are read through this predicate.
 */
export function isBdeAssociationSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM spaces bde_space WHERE bde_space."bdeAssociationId" = ${alias}.id)`;
}
