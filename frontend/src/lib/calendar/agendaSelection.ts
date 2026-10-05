import {
  CAMPUSES,
  FORMATIONS,
  campusLabel,
  formationLabel,
  type Campus,
  type CursusEntry,
  type Formation,
} from '$lib/profile/miconnectProfile';
import { m } from '$lib/paraglide/messages';
import type { PickerOption } from '$lib/components/ui/picker';

/**
 * WHICH AGENDA A FEED OR AN EXPORT IS FOR (D40, docs/wiki/profiles-and-access.md): the public agenda
 * is one feed per selection, and the server REFUSES a bare anonymous one. So every surface that
 * builds a feed URL (the subscribe modal) or asks for a month to print (the PDF export) holds one of
 * these. An empty side means "any".
 */
export interface AgendaSelection {
  campus: Campus | '';
  formation: Formation | '';
}

/** Nothing chosen: not a selection, and the server refuses it. */
export const EMPTY_AGENDA_SELECTION: AgendaSelection = { campus: '', formation: '' };

/** The reader's own facts the default is read from (a `UserProfile` carries both, WP3). */
export interface AgendaReader {
  campus?: Campus | null;
  cursus?: CursusEntry[] | null;
}

/**
 * The selection a reader starts from: THEIR campus and their FIRST cursus formation - the space
 * they live in. Whatever is unknown stays empty, so a reader with no space starts with nothing and
 * must choose; a default is never invented.
 */
export function defaultAgendaSelection(reader: AgendaReader | null | undefined): AgendaSelection {
  const campus = CAMPUSES.find((c) => c === reader?.campus) ?? '';
  const first = reader?.cursus?.find((entry) => FORMATIONS.some((f) => f === entry.formation));
  const formation = FORMATIONS.find((f) => f === first?.formation) ?? '';
  return { campus, formation };
}

/** Whether the selection names at least a campus or a formation - what the server asks for. */
export function isAgendaSelected(selection: AgendaSelection): boolean {
  return selection.campus !== '' || selection.formation !== '';
}

/** The campus choices, "any campus" first. */
export function campusSelectOptions(): PickerOption[] {
  return [
    { value: '', label: m.calendar_selection_any_campus() },
    ...CAMPUSES.map((c) => ({ value: c, label: campusLabel(c) })),
  ];
}

/** The formation choices, "any formation" first. */
export function formationSelectOptions(): PickerOption[] {
  return [
    { value: '', label: m.calendar_selection_any_formation() },
    ...FORMATIONS.map((f) => ({ value: f, label: formationLabel(f) })),
  ];
}
