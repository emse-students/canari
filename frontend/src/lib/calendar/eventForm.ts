import { toDatetimeLocalValue } from '$lib/utils/dates';
import { m } from '$lib/paraglide/messages';
import { Log } from '$lib/utils/Log';
import type {
  AssociationCalendarEventKind,
  CalendarEventCoOrganiserState,
  CreateAssociationCalendarEventPayload,
  UpdateAssociationCalendarEventPayload,
} from '$lib/associations/api';
import { DAY_STARTS_AT_HOUR } from './feedEvents';

/**
 * THE ONE SHAPE BEHIND FOUR MODALS.
 *
 * "Proposer un evenement", "Modifier l'evenement" (association page), "Deposer un evenement" and
 * "Modifier l'evenement" (global agenda) were two implementations of the same form under three
 * names - 840 and 732 lines carrying the same six fields declared twice. What actually differed was
 * never the form: it was WHICH fields each surface is allowed to decide, and that is a capability,
 * not a component.
 */
export interface EventFormValues {
  title: string;
  description: string;
  /** `datetime-local` text, in the viewer's zone - converted once, here, on submit. */
  start: string;
  end: string;
  kind: AssociationCalendarEventKind;
  /** `''` when no form is linked. */
  linkedFormId: string;
  /** The co-organisers named: accepted, pending, and newly added ones (D39 - each is ASKED). */
  coOwnerIds: string[];
  /**
   * Whether the co-organiser list may be SENT (D39). A new event is `ready`; an existing one is
   * `loading` until its states arrive (`withCoOrganiserStates`), and `failed` if they never do. Only
   * `ready` sends `coOwnerIds`: the event's own payload knows only the ACCEPTED co-organisers, so
   * sending a list seeded from it would withdraw every pending one.
   */
  coOwnersLoad: 'ready' | 'loading' | 'failed';
  /** Each co-organiser's state, as the server answered it - empty for a new event. */
  coOwnerStates: CalendarEventCoOrganiserState[];
  /** `''` on a surface that does not choose an association. */
  targetAssociationId: string;
}

/** The co-organiser half of the form, which arrives after the rest (D39). */
export type CoOrganiserFields = Pick<
  EventFormValues,
  'coOwnerIds' | 'coOwnerStates' | 'coOwnersLoad'
>;

/**
 * Reads an existing event's co-organiser states through `load` (`listEventCoOrganisers`, a
 * parameter so this stays testable without a network) and returns the fields to merge into the
 * form. A failure is `failed`, which keeps the list UNSENT - never a list guessed from the payload.
 * Both event surfaces call this, so they cannot disagree on what a failure means.
 */
export async function loadCoOrganiserFields(
  values: EventFormValues,
  load: () => Promise<CalendarEventCoOrganiserState[]>
): Promise<CoOrganiserFields> {
  try {
    const seeded = withCoOrganiserStates(values, await load());
    return {
      coOwnerIds: seeded.coOwnerIds,
      coOwnerStates: seeded.coOwnerStates,
      coOwnersLoad: seeded.coOwnersLoad,
    };
  } catch (e: unknown) {
    Log.d('eventForm', `co-organiser states failed to load: ${String(e)}`);
    return {
      coOwnerIds: values.coOwnerIds,
      coOwnerStates: values.coOwnerStates,
      coOwnersLoad: 'failed',
    };
  }
}

/**
 * Seeds an existing event's form with its co-organiser STATES (D39): the list becomes the accepted
 * and pending ones (a refused one is shown, never re-sent), and the list becomes sendable.
 */
export function withCoOrganiserStates(
  values: EventFormValues,
  states: CalendarEventCoOrganiserState[]
): EventFormValues {
  return {
    ...values,
    coOwnerIds: states.filter((s) => s.status !== 'refused').map((s) => s.associationId),
    coOwnerStates: states,
    coOwnersLoad: 'ready',
  };
}

/**
 * What a surface is allowed to decide. Everything here defaults to the NARROWEST answer, so a new
 * call site that forgets a flag renders the plain form rather than silently offering a right.
 */
export interface EventFormCapabilities {
  /** The entry may be turned into a school-wide break. BDE and global admins only. */
  canSetKind?: boolean;
  /** A registration form may be attached. The association's own page only. */
  canLinkForm?: boolean;
  /** The event may be filed under another association. The global agenda only. */
  canTargetAnotherAssociation?: boolean;
}

/** A refusal the form shows before anything is sent, with the sentence already chosen. */
export type EventFormRefusal = { ok: false; message: () => string };

export function validateEventForm(
  values: EventFormValues,
  caps: EventFormCapabilities
): { ok: true } | EventFormRefusal {
  // Order matters: the association picker sits ABOVE the title on the only surface that has one,
  // so complaining about the title first would point past the empty field.
  if (caps.canTargetAnotherAssociation && !values.targetAssociationId) {
    return { ok: false, message: m.calendar_error_choose_asso };
  }
  if (!values.title.trim() || !values.start) {
    return { ok: false, message: m.calendar_error_title_required };
  }
  return { ok: true };
}

/** `datetime-local` text to the instant the server stores, or `undefined` for an empty end. */
function instant(value: string): string | undefined {
  return value.trim() ? new Date(value).toISOString() : undefined;
}

/**
 * The create payload, carrying ONLY what this surface is entitled to decide.
 *
 * **An omitted field is not the same as an empty one**, which is the whole reason the capabilities
 * reach this far. The global agenda has never offered `kind` or a linked form; sending
 * `linkedFormId: null` from there because its form holds no value would CLEAR a link the
 * association's own page had set. So a field the surface cannot see is never written.
 */
export function toCreatePayload(
  values: EventFormValues,
  caps: EventFormCapabilities
): CreateAssociationCalendarEventPayload {
  return {
    title: values.title.trim(),
    description: values.description.trim() || undefined,
    startsAt: new Date(values.start).toISOString(),
    endsAt: instant(values.end),
    coOwnerIds: values.coOwnerIds,
    ...(caps.canSetKind ? { kind: values.kind } : {}),
    ...(caps.canLinkForm && values.linkedFormId.trim()
      ? { linkedFormId: values.linkedFormId.trim() }
      : {}),
  };
}

/** The update payload. `linkedFormId: null` DETACHES, so it is only ever sent by a surface that owns it. */
export function toUpdatePayload(
  values: EventFormValues,
  caps: EventFormCapabilities
): UpdateAssociationCalendarEventPayload {
  return {
    title: values.title.trim(),
    description: values.description.trim() || undefined,
    startsAt: new Date(values.start).toISOString(),
    endsAt: instant(values.end),
    // Omitted unless the states were read: see `coOwnersLoad`.
    ...(values.coOwnersLoad === 'ready' ? { coOwnerIds: values.coOwnerIds } : {}),
    ...(caps.canSetKind ? { kind: values.kind } : {}),
    ...(caps.canLinkForm ? { linkedFormId: values.linkedFormId.trim() || null } : {}),
  };
}

/**
 * A blank form - the defaults a NEW entry opens with, decided once.
 *
 * `onDay` is the square the user clicked before reaching for "create": having picked a day, being
 * handed today's date and asked to pick it again is the form ignoring what was already said. Pass
 * `null` where no day is selected, and the form opens on today as before.
 *
 * THE HOUR IS CLAMPED TO {@link DAY_STARTS_AT_HOUR}, and that is not cosmetic: this app's day
 * begins at 05:00, so seeding 02:00 on the 5th would open a form whose event belongs to the 4th -
 * the grid would draw it on the square BEFORE the one the user clicked.
 */
export function blankEventFormValues(onDay?: Date | null): EventFormValues {
  const now = new Date();
  if (onDay) {
    now.setFullYear(onDay.getFullYear(), onDay.getMonth(), onDay.getDate());
    now.setHours(Math.max(now.getHours(), DAY_STARTS_AT_HOUR));
  }
  now.setMinutes(0, 0, 0);
  return {
    title: '',
    description: '',
    start: toDatetimeLocalValue(now.toISOString()),
    end: '',
    kind: 'event',
    linkedFormId: '',
    coOwnerIds: [],
    coOwnersLoad: 'ready',
    coOwnerStates: [],
    targetAssociationId: '',
  };
}

/**
 * The form an existing event opens with.
 *
 * Every field is seeded, including the ones the surface will not render: a capability decides what
 * is SHOWN and what is SENT, and neither is a reason to forget what the event already holds.
 */
export function eventFormValuesFrom(ev: SeedableEvent): EventFormValues {
  return {
    title: ev.title,
    description: ev.description ?? '',
    start: toDatetimeLocalValue(ev.startsAt),
    end: ev.endsAt ? toDatetimeLocalValue(ev.endsAt) : '',
    kind: ev.kind ?? 'event',
    linkedFormId: ev.linkedFormId ?? '',
    // The ACCEPTED ones only, which is why the list is not sendable until the states arrive.
    coOwnerIds: (ev.coOwners ?? []).map((co) => co.associationId),
    coOwnersLoad: 'loading',
    coOwnerStates: [],
    targetAssociationId: ev.associationId,
  };
}

/** What `eventFormValuesFrom` needs of an event - satisfied by the feed row and the raw row alike. */
export interface SeedableEvent {
  associationId: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  kind?: AssociationCalendarEventKind;
  linkedFormId?: string | null;
  coOwners?: { associationId: string }[];
}
