/**
 * Rule row `rule` (an `association_audiences` row: formation/campus, NULL =
 * any) reaches space row `space` - the SQL twin of `ruleReachesSpace` in `spaces.service.ts`.
 *
 * Its own module, importing nothing, because two places splice it: the readers
 * (`reader-spaces.ts`) and the BDE governance predicate (`bde.ts`), and `bde.ts` is imported by the
 * `Association` entity - so whatever it imports must not reach back into the entities.
 */
export function ruleReachesSpaceSql(rule: string, space: string): string {
  return `((${rule}.formation IS NULL OR ${rule}.formation = ${space}.formation)
    AND (${rule}.campus IS NULL OR ${rule}.campus = ${space}.campus))`;
}
