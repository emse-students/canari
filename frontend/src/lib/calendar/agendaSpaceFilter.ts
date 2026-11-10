import {
  CAMPUSES,
  FORMATIONS,
  campusLabel,
  formationLabel,
  type Campus,
  type Formation,
} from '$lib/profile/miconnectProfile';
import { m } from '$lib/paraglide/messages';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import type { PickerOption } from '$lib/components/ui/picker';
import { Log } from '$lib/utils/Log';

/**
 * THE AGENDA'S SPACE FILTER (owner, 2026-11-10): a reader whose agenda shows several spaces
 * (formation x campus, D16) - staff, admins, a BDE - narrows the VIEW to one campus or one
 * formation. It replaces the "Association" select, which narrowed nothing a reader thinks in.
 *
 * IT FILTERS THE VIEW AND NOTHING ELSE: the server already restricted the feed to what the reader may
 * see, and the narrowing it applies on top is the very `campus` / `formation` query of the public
 * agenda (D40, `eventReachesSpaceMatchingSql`). The options come from the spaces the reader's agenda
 * reaches (`GET /api/associations/calendar/spaces`), so an option is never offered that keeps
 * nothing by construction.
 */

/** A space as the server names it. Unknown values are dropped, never guessed at. */
export interface AgendaSpace {
  formation: string;
  campus: string;
}

/** What the filter narrows to: a side left empty is "any". */
export interface AgendaSpaceNarrowing {
  campus: Campus | '';
  formation: Formation | '';
}

/** "Every space" - the filter off. Also what an unknown stored value falls back to. */
export const ALL_SPACES = '';

const CAMPUS_PREFIX = 'campus:';
const FORMATION_PREFIX = 'formation:';

const knownCampus = (v: string): v is Campus => (CAMPUSES as readonly string[]).includes(v);
const knownFormation = (v: string): v is Formation => (FORMATIONS as readonly string[]).includes(v);

/** The spaces whose campus AND formation this client knows how to name. */
function namedSpaces(spaces: readonly AgendaSpace[]): { campus: Campus; formation: Formation }[] {
  return spaces.flatMap((s) =>
    knownCampus(s.campus) && knownFormation(s.formation)
      ? [{ campus: s.campus, formation: s.formation }]
      : []
  );
}

/**
 * Whether the filter is worth drawing: only a reader whose agenda reaches MORE THAN ONE space has
 * anything to narrow (a student with one space would be offered a choice that changes nothing).
 */
export function hasSeveralSpaces(spaces: readonly AgendaSpace[]): boolean {
  return namedSpaces(spaces).length > 1;
}

/**
 * The filter's options: "all spaces", then the campuses the reader reaches, then their formations.
 * Only what the reader's spaces name is listed. Empty when {@link hasSeveralSpaces} is false.
 */
export function agendaSpaceOptions(spaces: readonly AgendaSpace[]): PickerOption[] {
  const named = namedSpaces(spaces);
  if (named.length < 2) return [];
  const campuses = CAMPUSES.filter((c) => named.some((s) => s.campus === c));
  const formations = FORMATIONS.filter((f) => named.some((s) => s.formation === f));
  const options: PickerOption[] = [{ value: ALL_SPACES, label: m.calendar_space_filter_all() }];
  for (const c of campuses) {
    options.push({
      value: CAMPUS_PREFIX + c,
      label: campusLabel(c),
      group: m.calendar_space_filter_campuses(),
    });
  }
  for (const f of formations) {
    options.push({
      value: FORMATION_PREFIX + f,
      label: formationLabel(f),
      group: m.calendar_space_filter_formations(),
    });
  }
  return options;
}

/**
 * Whether `value` is one of `options`' values. A remembered choice that is no longer offered (the
 * reader's spaces changed) is not applied: the filter falls back to "all", and says so in the log.
 */
export function coerceAgendaSpaceValue(value: string, options: readonly PickerOption[]): string {
  if (options.some((o) => o.value === value)) return value;
  if (value !== ALL_SPACES)
    Log.d(`calendar.spaceFilter: "${value}" is no longer offered, showing all`);
  return ALL_SPACES;
}

/** The `campus` / `formation` the feed is asked for under `value`. Unknown means no narrowing. */
export function narrowingOf(value: string): AgendaSpaceNarrowing {
  if (value.startsWith(CAMPUS_PREFIX)) {
    const c = value.slice(CAMPUS_PREFIX.length);
    if (knownCampus(c)) return { campus: c, formation: '' };
  }
  if (value.startsWith(FORMATION_PREFIX)) {
    const f = value.slice(FORMATION_PREFIX.length);
    if (knownFormation(f)) return { campus: '', formation: f };
  }
  return { campus: '', formation: '' };
}

/** The choice this reader last made, or "all" - a read that fails is the same as no choice. */
export function readRememberedSpaceValue(userId: string | null): string {
  if (!userId || typeof localStorage === 'undefined') return ALL_SPACES;
  try {
    return localStorage.getItem(ACCOUNT_KEY.agendaSpaceFilter(userId)) ?? ALL_SPACES;
  } catch (err) {
    Log.d('calendar.spaceFilter: remembered choice unreadable', err);
    return ALL_SPACES;
  }
}

/** Remembers the choice for this reader only ("all" forgets it). A view setting: failure is logged. */
export function rememberSpaceValue(userId: string | null, value: string): void {
  if (!userId || typeof localStorage === 'undefined') return;
  try {
    const key = ACCOUNT_KEY.agendaSpaceFilter(userId);
    if (value === ALL_SPACES) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (err) {
    Log.d('calendar.spaceFilter: choice could not be remembered', err);
  }
}
