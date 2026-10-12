import { CAMPUSES, FORMATIONS, type Campus, type Formation } from '$lib/profile/miconnectProfile';
import type { AudienceRule } from './api';

/** One formation x campus pair, the unit an audience is made of. */
export type Cell = `${Formation}|${Campus}`;

const key = (formation: Formation, campus: Campus): Cell => `${formation}|${campus}`;

/** Every pair that exists: there is no "opening" of one, they are all always there. */
export const ALL_CELLS: readonly Cell[] = CAMPUSES.flatMap((c) => FORMATIONS.map((f) => key(f, c)));

/**
 * The pairs a rule set reaches. A `null` side is "any", so `(null, campus)` is every formation on
 * that campus and `(null, null)` is everyone.
 */
export function reachedCells(rules: AudienceRule[]): Set<Cell> {
  const reached = new Set<Cell>();
  for (const campus of CAMPUSES) {
    for (const formation of FORMATIONS) {
      if (
        rules.some(
          (r) =>
            (r.formation === null || r.formation === formation) &&
            (r.campus === null || r.campus === campus)
        )
      ) {
        reached.add(key(formation, campus));
      }
    }
  }
  return reached;
}

/**
 * The smallest rule set that reaches exactly these pairs: everyone when all are in, a campus rule
 * when a whole campus is in, a pair rule otherwise. Saving the canonical form is what lets a campus
 * rule keep covering a formation added later, and keeps what the page shows equal to what is stored.
 */
export function toRules(cells: Set<Cell>): AudienceRule[] {
  if (ALL_CELLS.every((c) => cells.has(c))) return [{ formation: null, campus: null }];
  const rules: AudienceRule[] = [];
  for (const campus of CAMPUSES) {
    if (FORMATIONS.every((f) => cells.has(key(f, campus)))) {
      rules.push({ formation: null, campus });
      continue;
    }
    for (const formation of FORMATIONS) {
      if (cells.has(key(formation, campus))) rules.push({ formation, campus });
    }
  }
  return rules;
}

/** How a group of pairs is selected: none, some (a partial parent, like a half-ticked folder) or all. */
export type Coverage = 'none' | 'some' | 'all';

/** The coverage of a set of pairs by the reached ones. */
export function coverage(cells: readonly Cell[], reached: Set<Cell>): Coverage {
  const n = cells.filter((c) => reached.has(c)).length;
  return n === 0 ? 'none' : n === cells.length ? 'all' : 'some';
}

/** The pairs of one campus. */
export function campusCells(campus: Campus): Cell[] {
  return FORMATIONS.map((f) => key(f, campus));
}

/** One pair, as a list of one. */
export function cellOf(formation: Formation, campus: Campus): Cell {
  return key(formation, campus);
}

/**
 * Toggles a group of pairs: when all are reached it clears them, otherwise it reaches them all.
 * That is the rule of a parent checkbox, at the campus level and at the everyone level alike.
 */
export function toggleGroup(reached: Set<Cell>, group: readonly Cell[]): Set<Cell> {
  const next = new Set(reached);
  const clear = group.every((c) => reached.has(c));
  for (const c of group) {
    if (clear) next.delete(c);
    else next.add(c);
  }
  return next;
}

/** What a creation form offers for an audience, from nothing to one campus x formation pair. */
export type ReachChoice = 'none' | 'school' | 'campus' | 'cell' | 'custom';

/**
 * The rules a creation form's audience choice stands for. `none` is the empty set (the server
 * writes no rule for a new institution, so it is visible to its members only), `school` is the
 * `(null, null)` rule, `campus` a campus rule and `cell` a single formation x campus pair. A choice
 * that still lacks its campus or formation yields NO rule rather than a wider one: a half-filled
 * form must never widen a reach. `custom` is the pairs ticked on the grid, in the smallest equivalent
 * rule set (`toRules`): the way to say a union of several campuses or formations.
 */
export function reachChoiceToRules(
  choice: ReachChoice,
  campus: Campus | '',
  formation: Formation | '',
  cells: ReadonlySet<Cell> = new Set()
): AudienceRule[] {
  if (choice === 'custom') return toRules(new Set(cells));
  if (choice === 'school') return [{ formation: null, campus: null }];
  if (choice === 'campus' && campus) return [{ formation: null, campus }];
  if (choice === 'cell' && campus && formation) return [{ formation, campus }];
  return [];
}
