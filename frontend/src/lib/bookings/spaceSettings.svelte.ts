/**
 * THE SPACE EDITOR'S DRAFT, AND ITS TRANSLATION TO THE API (WP-B4, D35).
 *
 * A form field holds text; the API holds integers, `null` for "no limit", and an ISO instant. This
 * module is the one place the two meet, so the editor binds plain strings and every conversion,
 * every bound and the count behind the "rules active" badge is a table test. The bounds are the
 * DTO's (`apps/social-service/src/bookings/dto/space.dto.ts`): a value the server would refuse is
 * caught here, by field, before a save.
 */
import type { AudienceCondition, FormItem } from '$lib/forms/api';
import { instantOfWallTime, wallTimeIn } from './wallTime';
import { BOOKING_NOTIFICATIONS_LIVE } from './notified';
import { reminderFromValue, reminderValue } from './reminder';
import type {
  Discoverability,
  ManagedSpace,
  NameVisibility,
  QuotaPeriod,
  SlotMode,
  SpaceSettings,
} from './api';

/** The integer settings, each a text field in the editor; `''` is "none". */
export const NUMBER_FIELDS = [
  'stepMinutes',
  'minNoticeMinutes',
  'horizonDays',
  'maxActiveBookings',
  'maxMinutesPerPeriod',
  'participantWithdrawMinMinutes',
  'maxPeople',
  'retentionDays',
] as const;

export type NumberField = (typeof NUMBER_FIELDS)[number];

/** The DTO's bound on `maxSteps`: how many steps one booking may cover when a maximum is set. */
export const MAX_STEPS_BOUND = 96;

/** The DTO's bounds, both included. */
export const NUMBER_BOUNDS: Record<NumberField, { min: number; max: number }> = {
  stepMinutes: { min: 5, max: 1440 },
  minNoticeMinutes: { min: 0, max: 525_600 },
  horizonDays: { min: 1, max: 730 },
  maxActiveBookings: { min: 1, max: 1000 },
  maxMinutesPerPeriod: { min: 1, max: 10_080 },
  participantWithdrawMinMinutes: { min: 0, max: 525_600 },
  maxPeople: { min: 1, max: 50 },
  retentionDays: { min: 1, max: 30 },
};

/** What the editor binds. */
export interface SettingsDraft extends Record<NumberField, string> {
  /**
   * The longest single booking of a step space, in minutes; `''` = no limit (migration 151). Stored
   * as `maxSteps` = minutes / step, so it must be a multiple of the step.
   */
  maxMinutes: string;
  name: string;
  description: string;
  timeZone: string;
  privateInfo: string;
  slotMode: SlotMode;
  /**
   * A 'slots' space's slot length in minutes, chosen from the wizard's list (so never out of
   * range); `''` = not stored (a space created before migration 116), whose painter reads it
   * from the lines. Not sent on a step space.
   */
  slotMinutes: string;
  nameVisibility: NameVisibility;
  discoverability: Discoverability;
  audience: AudienceCondition | null;
  items: FormItem[];
  /**
   * The DateTimeField's wall time (`YYYY-MM-DDTHH:mm`) in the SPACE's zone (D25), `''` for none -
   * the zone the draft will save, so a change of zone keeps the wall time and moves the instant.
   */
  opensAt: string;
  /** Always a period; it only counts when `maxMinutesPerPeriod` is set. */
  quotaPeriod: QuotaPeriod;
  /** The default reminder delay as a `Select` value (`reminder.ts`), "none" for no reminder. */
  reminderMinutes: string;
}

const text = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

/**
 * The draft of a space as the server answered it. The caller's space is usually `$state` (the edit
 * page holds it so, and hands it down as a prop), so the nested values are copied with
 * `$state.snapshot`, never `structuredClone`: a proxy is not cloneable and threw `DataCloneError`
 * on every open of the editor (v1.3.0-alpha.2). The copy also keeps the draft from sharing the
 * page's audience proxy, which the audience editor would otherwise write through.
 */
export function draftFromSpace(space: ManagedSpace): SettingsDraft {
  const numbers = Object.fromEntries(NUMBER_FIELDS.map((f) => [f, text(space[f])])) as Record<
    NumberField,
    string
  >;
  return {
    ...numbers,
    maxMinutes:
      space.slotMode === 'step' && space.maxSteps !== null && space.stepMinutes !== null
        ? String(space.maxSteps * space.stepMinutes)
        : '',
    name: space.name,
    description: space.description ?? '',
    timeZone: space.timeZone,
    privateInfo: space.privateInfo ?? '',
    slotMode: space.slotMode,
    slotMinutes: text(space.slotMinutes),
    nameVisibility: space.nameVisibility,
    discoverability: space.discoverability,
    audience: $state.snapshot(space.audience ?? null),
    items: $state.snapshot(space.items ?? []),
    opensAt: space.opensAt ? wallTimeIn(Date.parse(space.opensAt), space.timeZone) : '',
    quotaPeriod: space.quotaPeriod ?? 'week',
    reminderMinutes: reminderValue(space.reminderMinutes ?? null),
  };
}

/** `''` is null; anything else must be a whole number inside the field's bounds. */
function parseNumber(field: NumberField, value: string): number | null | 'invalid' {
  const v = value.trim();
  if (v === '') return null;
  if (!/^\d+$/.test(v)) return 'invalid';
  const n = Number(v);
  const { min, max } = NUMBER_BOUNDS[field];
  return n < min || n > max ? 'invalid' : n;
}

/** The fields that may not be empty, whatever the mode. */
const REQUIRED: readonly NumberField[] = ['participantWithdrawMinMinutes', 'retentionDays'];

/** Why the draft cannot be saved, by field; empty when it can. */
export type DraftProblems = Partial<
  Record<NumberField | 'name' | 'maxMinutes', 'required' | 'range'>
>;

/**
 * `maxSteps` for a typed maximum in minutes, null for an empty field (no limit), `'invalid'` when it
 * is not a whole multiple of the step or covers more than {@link MAX_STEPS_BOUND} steps.
 */
export function maxStepsFromMinutes(
  minutes: string,
  stepMinutes: string
): number | null | 'invalid' {
  const v = minutes.trim();
  if (v === '') return null;
  const step = parseNumber('stepMinutes', stepMinutes);
  if (!/^\d+$/.test(v) || typeof step !== 'number') return 'invalid';
  const n = Number(v);
  return n > 0 && n % step === 0 && n / step <= MAX_STEPS_BOUND ? n / step : 'invalid';
}

export function draftProblems(draft: SettingsDraft): DraftProblems {
  const problems: DraftProblems = {};
  if (!draft.name.trim()) problems.name = 'required';
  for (const field of NUMBER_FIELDS) {
    // A slots space carries no step: its two fields are not read, so they are not judged.
    if (draft.slotMode === 'slots' && field === 'stepMinutes') continue;
    const parsed = parseNumber(field, draft[field]);
    if (parsed === 'invalid') problems[field] = 'range';
    else if (parsed === null) {
      const stepNeeded = draft.slotMode === 'step' && field === 'stepMinutes';
      if (stepNeeded || REQUIRED.includes(field)) problems[field] = 'required';
    }
  }
  // Empty is no limit; a typed one must fit whole steps. A step the draft got wrong is its own
  // problem, so it is not judged here twice.
  if (draft.slotMode === 'step' && problems.stepMinutes === undefined) {
    if (maxStepsFromMinutes(draft.maxMinutes, draft.stepMinutes) === 'invalid') {
      problems.maxMinutes = 'range';
    }
  }
  return problems;
}

/**
 * The settings to send, or null while `draftProblems` names one. Every setting is sent: the editor
 * shows them all, so a PATCH of the whole is what the screen says.
 */
export function settingsFromDraft(
  draft: SettingsDraft
):
  | (Omit<SpaceSettings, 'reminderMinutes'> & Partial<Pick<SpaceSettings, 'reminderMinutes'>>)
  | null {
  if (Object.keys(draftProblems(draft)).length) return null;
  const num = (f: NumberField) => parseNumber(f, draft[f]) as number | null;
  const opens = draft.opensAt ? instantOfWallTime(draft.opensAt, draft.timeZone) : null;
  const quotaMinutes = num('maxMinutesPerPeriod');
  const step = draft.slotMode === 'step';
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    timeZone: draft.timeZone,
    privateInfo: draft.privateInfo.trim() || null,
    slotMode: draft.slotMode,
    stepMinutes: step ? num('stepMinutes') : null,
    maxSteps: step
      ? (maxStepsFromMinutes(draft.maxMinutes, draft.stepMinutes) as number | null)
      : null,
    // The mirror: a step space stores no slot length, so a switch to step clears it.
    slotMinutes: step || draft.slotMinutes === '' ? null : Number(draft.slotMinutes),
    nameVisibility: draft.nameVisibility,
    discoverability: draft.discoverability,
    audience: draft.audience,
    items: draft.items,
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- read once into a string, never stored
    opensAt: opens === null ? null : new Date(opens).toISOString(),
    minNoticeMinutes: num('minNoticeMinutes'),
    horizonDays: num('horizonDays'),
    maxActiveBookings: num('maxActiveBookings'),
    maxMinutesPerPeriod: quotaMinutes,
    // The server's CHECK: both set or both null (`quota-pair`).
    quotaPeriod: quotaMinutes === null ? null : draft.quotaPeriod,
    participantWithdrawMinMinutes: num('participantWithdrawMinMinutes') as number,
    maxPeople: num('maxPeople'),
    retentionDays: num('retentionDays') as number,
    // Sent only while the notices are live: off, the field is not shown, and a save must not
    // touch a default nobody was offered (WP-N).
    ...(BOOKING_NOTIFICATIONS_LIVE
      ? { reminderMinutes: reminderFromValue(draft.reminderMinutes) }
      : {}),
  };
}

/**
 * How many of the collapsed "booking rules" (D35 section 4) are set - the badge on the collapsed
 * section, as forms' advanced settings show one, so a rule is never hidden AND forgotten. The
 * ceiling of people is NOT one of them since WP-R6 (Q-R13): it sits in "who", always in view.
 */
export function activeRuleCount(draft: SettingsDraft): number {
  const set = (v: string) => v.trim() !== '';
  return [
    set(draft.opensAt),
    set(draft.minNoticeMinutes),
    set(draft.horizonDays),
    set(draft.maxActiveBookings),
    set(draft.maxMinutesPerPeriod),
    set(draft.participantWithdrawMinMinutes) && draft.participantWithdrawMinMinutes.trim() !== '0',
  ].filter(Boolean).length;
}

/** Every IANA zone the engine knows, the space's own first if the engine lacks it. */
export function timeZoneChoices(current: string): string[] {
  const zones = Intl.supportedValuesOf('timeZone');
  return zones.includes(current) ? zones : [current, ...zones];
}
