import type { Campus, Formation } from '$lib/profile/miconnectProfile';
import type { AudienceRule } from './api';

/**
 * THE PRESETS OF AN AUDIENCE (user, 2026-10-07, decision 1): a manager never edits the raw grid, they
 * choose what the entity reaches in terms of ONE campus. The grid at `/admin/spaces` stays the global
 * admin's tool for everything else.
 *
 * - `campus`: the whole campus, every formation (the default at creation, decision 2);
 * - `formations`: that campus, restricted to the formations the manager names;
 * - `everyone`: every campus and formation - an institution's alone (decision 6). The SERVER refuses
 *   it elsewhere; hiding it here is a convenience, never the rule.
 */
export type AudiencePreset = 'campus' | 'formations' | 'everyone';

/** The entity kinds the audience editor is drawn for. */
export type AudienceEntityType = 'association' | 'list' | 'institution';

/** The presets offered for an entity: `everyone` for an institution only (decision 6). */
export function offeredPresets(type: AudienceEntityType): AudiencePreset[] {
  return type === 'institution' ? ['campus', 'formations', 'everyone'] : ['campus', 'formations'];
}

/**
 * The rules a preset stands for. `formations` with no formation named, or a campus-based preset
 * with no campus, yields NO rule rather than a wider one: a half-filled choice must never widen a
 * reach (the same rule as `reachChoiceToRules`).
 */
export function presetToRules(
  preset: AudiencePreset,
  campus: Campus | '',
  formations: readonly Formation[]
): AudienceRule[] {
  if (preset === 'everyone') return [{ formation: null, campus: null }];
  if (!campus) return [];
  if (preset === 'campus') return [{ formation: null, campus }];
  return formations.map((formation) => ({ formation, campus }));
}

/** What a stored rule set looks like in preset terms; `null` when it is not one of them (a grid edit). */
export interface PresetReading {
  preset: AudiencePreset;
  campus: Campus | '';
  formations: Formation[];
}

/**
 * Reads a stored rule set back into a preset, so the editor opens on what is in force. Anything that
 * is not exactly one preset - several campuses, a campus mixed with formation rules - is `null`:
 * the editor then says it is a custom audience rather than pretending it is one of the three.
 */
export function readPreset(rules: readonly AudienceRule[]): PresetReading | null {
  if (rules.length === 0) return null;
  if (rules.length === 1 && rules[0].campus === null && rules[0].formation === null) {
    return { preset: 'everyone', campus: '', formations: [] };
  }
  const campuses = new Set(rules.map((r) => r.campus));
  if (campuses.size !== 1) return null;
  const [campus] = [...campuses];
  if (campus === null) return null;
  if (rules.length === 1 && rules[0].formation === null) {
    return { preset: 'campus', campus, formations: [] };
  }
  if (rules.every((r) => r.formation !== null)) {
    return { preset: 'formations', campus, formations: rules.map((r) => r.formation as Formation) };
  }
  return null;
}
