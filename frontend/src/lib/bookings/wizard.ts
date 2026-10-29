/**
 * THE CREATION WIZARD'S MODEL, AND ITS ONE CALL (WP-R7, D52, Q-R14).
 *
 * Three steps - C'est quoi ? / Quand ? / Pour qui ? - and ONE `POST bookings/spaces` at the end,
 * carrying the settings the steps asked and the first hours of the space's hidden column (WP-R1),
 * so a space is never half made. Every setting the wizard does not ask keeps the SERVER's default
 * (nothing in "Regles de reservation", answers kept 7 days): the wizard sends only what it asked,
 * which is why a wizard space and a space set up in the five sections read the same settings back.
 *
 * Pure, so the payload, the problems and the fixed-slot cutting are table tests.
 */
import type { AudienceCondition } from '$lib/forms/api';
import type {
  CreateSpaceFields,
  Discoverability,
  NameVisibility,
  SlotMode,
  SpacePoster,
} from './api';
import {
  lineProblem,
  minutesOf,
  toStoredLines,
  type EditorLine,
  type StoredLine,
} from './availability';
import { applyTemplate, timeOfMinutes, type TemplateKey } from './availabilityPaint';
import { NUMBER_BOUNDS } from './spaceSettings.svelte';

/**
 * The server's cap on the lines one availability carries (`MAX_AVAILABILITY_LINES`,
 * `apps/social-service/src/bookings/dto/space.dto.ts`): fixed slots are one line each, so a long
 * week of short slots can pass it, and the wizard says so before the server refuses.
 */
export const MAX_CREATION_LINES = 200;

/** The steps a "Au choix" booking is cut in. */
export const STEP_CHOICES = [15, 30, 60] as const;
/** How long a "Au choix" booking may last at most. */
export const MAX_DURATION_CHOICES = [30, 60, 90, 120, 180, 240, 360, 480] as const;
/** How long one fixed slot lasts. */
export const SLOT_LENGTH_CHOICES = [15, 20, 25, 30, 45, 60, 90, 120] as const;

/** What the three steps bind. */
export interface WizardDraft {
  name: string;
  description: string;
  /** Uploaded the moment it is picked, claimed by the creation (as the editor's poster). */
  poster: SpacePoster | null;
  /** The template last chosen, marked in the list; the rows are what is sent. */
  template: TemplateKey;
  /** The hidden column's hours, in the availability editor's own model. */
  rows: EditorLine[];
  slotMode: SlotMode;
  stepMinutes: number;
  maxMinutes: number;
  slotMinutes: number;
  /** Off = everybody (`audience: null`); on = the criteria of `audience`. */
  restricted: boolean;
  audience: AudienceCondition;
  nameVisibility: NameVisibility;
  discoverability: Discoverability;
}

/**
 * A new draft, named as the organiser typed it. The defaults are the mockup's (D52): a working
 * week 8h-20h, bookings of up to 2 h by 30 min, everybody, names hidden, listed - and the last
 * three are also the server's own defaults.
 */
export function newWizardDraft(name: string): WizardDraft {
  return {
    name,
    description: '',
    poster: null,
    template: 'weekdays',
    rows: applyTemplate([], 'weekdays'),
    slotMode: 'step',
    stepMinutes: 30,
    maxMinutes: 120,
    slotMinutes: 30,
    restricted: false,
    audience: {},
    nameVisibility: 'occupied',
    discoverability: 'listed',
  };
}

/**
 * The stored lines cut into fixed slots of `minutes`, one line per slot: in a `slots` space each
 * line IS one slot (WP-B2). A slot never crosses midnight (a stored line never does) and a tail
 * shorter than `minutes` is not offered.
 */
export function fixedSlotLines(lines: readonly StoredLine[], minutes: number): StoredLine[] {
  const out: StoredLine[] = [];
  for (const line of lines) {
    const end = minutesOf(line.endTime);
    for (let start = minutesOf(line.startTime); start + minutes <= end; start += minutes) {
      out.push({
        ...line,
        startTime: timeOfMinutes(start),
        endTime: timeOfMinutes(start + minutes),
      });
    }
  }
  return out;
}

/** The lines the creation will store for the draft's hours and mode. */
export function wizardLines(draft: WizardDraft): StoredLine[] {
  const stored = toStoredLines(draft.rows);
  return draft.slotMode === 'slots' ? fixedSlotLines(stored, draft.slotMinutes) : stored;
}

/** Why a step cannot be left, by step; empty when the space can be created. */
export interface WizardProblems {
  /** Step 1: the name is empty. */
  name?: 'required';
  /** Step 2: a line to fix (a date not set), a duration that is not whole steps, too many slots. */
  hours?: 'line' | 'duration' | 'too-many';
}

export function wizardProblems(draft: WizardDraft): WizardProblems {
  const problems: WizardProblems = {};
  if (!draft.name.trim()) problems.name = 'required';
  if (draft.rows.some((r) => lineProblem(r) !== null)) problems.hours = 'line';
  else if (
    draft.slotMode === 'step' &&
    (draft.maxMinutes < draft.stepMinutes ||
      draft.maxMinutes % draft.stepMinutes !== 0 ||
      draft.maxMinutes / draft.stepMinutes > NUMBER_BOUNDS.maxSteps.max)
  ) {
    problems.hours = 'duration';
  } else if (wizardLines(draft).length > MAX_CREATION_LINES) problems.hours = 'too-many';
  return problems;
}

/** The creation's body, or null while `wizardProblems` names one. */
export function wizardPayload(
  draft: WizardDraft
): { name: string; fields: CreateSpaceFields; lines: StoredLine[] } | null {
  if (Object.keys(wizardProblems(draft)).length) return null;
  const step = draft.slotMode === 'step';
  return {
    name: draft.name.trim(),
    fields: {
      description: draft.description.trim() || null,
      ...(draft.poster ? { poster: draft.poster } : {}),
      slotMode: draft.slotMode,
      // A slots space carries no step: the server clears both, and the draft never sends them.
      ...(step
        ? { stepMinutes: draft.stepMinutes, maxSteps: draft.maxMinutes / draft.stepMinutes }
        : {}),
      audience: draft.restricted ? draft.audience : null,
      nameVisibility: draft.nameVisibility,
      discoverability: draft.discoverability,
    },
    lines: wizardLines(draft),
  };
}
