import { toDatetimeLocalValue } from '$lib/utils/dates';
import { m } from '$lib/paraglide/messages';
import { Log } from '$lib/utils/Log';
import type {
  AssociationCalendarEventKind,
  AssociationCalendarEventPresentation,
  CalendarEventCoOrganiserState,
  EventWriteSide,
  CreateAssociationCalendarEventPayload,
  UpdateAssociationCalendarEventPayload,
} from '$lib/associations/api';
import { DAY_STARTS_AT_HOUR } from './feedEvents';
import {
  emptyReachDraft,
  isReachComplete,
  plainReach,
  reachDraftFrom,
  type InstitutionReach,
  type InstitutionReachDraft,
} from '$lib/posts/institutionReach';

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
  /**
   * `neutral`: shown as "Campus", no association (owner, 2026-11-08). Decided only where
   * `canSetPresentation`; a neutral event carries no co-organiser and no linked form, so the form
   * hides both pickers and leaves both fields unsent while it is chosen.
   */
  presentation: AssociationCalendarEventPresentation;
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
  /**
   * The side the viewer writes this event from, AS THE SERVER SAID IT (E2). A new event is the
   * writer's own (`organiser`); an existing one is `unknown` until the answer arrives and STAYS
   * unknown if it never does - the date and the partner list are drawn and sent for `organiser`
   * only, so a lost answer narrows the form instead of offering what the write would refuse.
   */
  writeSide: EventWriteSide | 'unknown';
  /**
   * THE REACH AN INSTITUTION CHOOSES FOR THE EVENT (owner, 2026-11-13; the posts' model): the
   * spaces and the public, nothing pre-selected. Drawn and sent only where `canSetReach` (the owner
   * is an institution) and from the organiser side; a new event seeds it empty, an existing one from
   * its served `reach`.
   */
  reach: InstitutionReachDraft;
  /**
   * Whether an incomplete reach blocks the save: a new institution event, or one already carrying a
   * reach. An event filed before the reach existed (`reach: null`) opens with the picker empty and
   * saves without a reach until a choice is complete, as a legacy post does.
   */
  reachRequired: boolean;
  /**
   * The author changed the picker. An edit sends a reach only then: the picker prunes, on its own, a
   * ticked space the audience no longer holds, and that is not a choice (review of #3314).
   */
  reachTouched: boolean;
}

/** The half of the form that arrives after the rest: the co-organisers (D39) and the side (E2). */
export type CoOrganiserFields = Pick<
  EventFormValues,
  'coOwnerIds' | 'coOwnerStates' | 'coOwnersLoad' | 'writeSide'
>;

/**
 * Reads an existing event's co-organiser states through `load` (`listEventCoOrganisers`, a
 * parameter so this stays testable without a network) and the side the viewer writes it from
 * through `loadSide` (`getEventWriteSide`), and returns the fields to merge into the form. EITHER
 * failing is `failed` with the side left `unknown`, which keeps the list UNSENT and the date
 * hidden - never a list guessed from the payload, never a right guessed from the ids. Both event
 * surfaces call this, so they cannot disagree on what a failure means.
 */
export async function loadCoOrganiserFields(
  values: EventFormValues,
  load: () => Promise<CalendarEventCoOrganiserState[]>,
  loadSide: () => Promise<{ side: EventWriteSide }>
): Promise<CoOrganiserFields> {
  try {
    const [states, { side }] = await Promise.all([load(), loadSide()]);
    const seeded = withCoOrganiserStates(values, states);
    return {
      coOwnerIds: seeded.coOwnerIds,
      coOwnerStates: seeded.coOwnerStates,
      coOwnersLoad: seeded.coOwnersLoad,
      writeSide: side,
    };
  } catch (e: unknown) {
    Log.d('eventForm', `co-organiser states or write side failed to load: ${String(e)}`);
    return {
      coOwnerIds: values.coOwnerIds,
      coOwnerStates: values.coOwnerStates,
      coOwnersLoad: 'failed',
      writeSide: 'unknown',
    };
  }
}

/**
 * What a PARTNER's withdrawal sends: the co-organisers the form holds, minus the viewer's own
 * association. The server lets a partner write exactly this and nothing else about the list (E2).
 */
export function withdrawalCoOwnerIds(
  states: CalendarEventCoOrganiserState[],
  ownAssociationId: string
): string[] {
  return states
    .filter((s) => s.status !== 'refused' && s.associationId !== ownAssociationId)
    .map((s) => s.associationId);
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
  /**
   * The event may be filed as NEUTRAL ("Campus"): the target is a BDE and the viewer manages its
   * agenda (PROPOSE_EVENT in it, or its validator, or a platform admin) - the server's own rule.
   */
  canSetPresentation?: boolean;
  /**
   * The event's owner is an INSTITUTION, so it chooses the event's spaces and public (owner,
   * 2026-11-13) - mandatory on a new event. The server's own rule (`institution_reach_*`).
   */
  canSetReach?: boolean;
}

/** Whether the form, as it stands, draws the reach picker: an institution's event, organiser side. */
export function offersReach(values: EventFormValues, caps: EventFormCapabilities): boolean {
  return caps.canSetReach === true && values.writeSide === 'organiser';
}

/**
 * Whether the reach keeps the save disabled ("Déposer" stays disabled until the spaces and the
 * public are chosen, owner 2026-11-13): offered, required, and not complete.
 */
export function reachBlocksSave(values: EventFormValues, caps: EventFormCapabilities): boolean {
  return offersReach(values, caps) && values.reachRequired && !isReachComplete(values.reach);
}

/** The reach a payload carries, as plain objects (never the picker's `$state` proxies). */
function reachPayload(values: EventFormValues): { reach: InstitutionReach } | object {
  return isReachComplete(values.reach) ? { reach: plainReach(values.reach) } : {};
}

/** Whether the form, as it stands, files a neutral event. */
export function isNeutralForm(values: EventFormValues, caps: EventFormCapabilities): boolean {
  return caps.canSetPresentation === true && values.presentation === 'neutral';
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
  if (reachBlocksSave(values, caps)) {
    return { ok: false, message: m.event_reach_required };
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
  // A neutral event names no partner and links no form: the hidden pickers' leftovers stay unsent.
  const neutral = isNeutralForm(values, caps);
  return {
    title: values.title.trim(),
    description: values.description.trim() || undefined,
    startsAt: new Date(values.start).toISOString(),
    endsAt: instant(values.end),
    coOwnerIds: neutral ? [] : values.coOwnerIds,
    ...(caps.canSetKind ? { kind: values.kind } : {}),
    ...(caps.canSetPresentation ? { presentation: values.presentation } : {}),
    // An institution's event names its reach at EVERY filing; the save is disabled until it does.
    ...(offersReach(values, caps) ? reachPayload(values) : {}),
    ...(!neutral && caps.canLinkForm && values.linkedFormId.trim()
      ? { linkedFormId: values.linkedFormId.trim() }
      : {}),
  };
}

/** The update payload. `linkedFormId: null` DETACHES, so it is only ever sent by a surface that owns it. */
export function toUpdatePayload(
  values: EventFormValues,
  caps: EventFormCapabilities
): UpdateAssociationCalendarEventPayload {
  // Turning an event neutral never withdraws its partners or detaches its form behind the reader's
  // back: both stay UNSENT, and the server refuses (`CALENDAR_NEUTRAL_NO_PARTNERS` / `_NO_FORM`)
  // until they are removed by hand, with the pickers the association presentation shows.
  const neutral = isNeutralForm(values, caps);
  return {
    title: values.title.trim(),
    description: values.description.trim() || undefined,
    // E2: the date and the partner list are the ORGANISER's. For a partner (or while the side is
    // unknown) they are not merely hidden but UNSENT, so the save is text-only and cannot be refused.
    ...(values.writeSide === 'organiser'
      ? { startsAt: new Date(values.start).toISOString(), endsAt: instant(values.end) }
      : {}),
    // Omitted unless the states were read: see `coOwnersLoad`.
    ...(!neutral && values.writeSide === 'organiser' && values.coOwnersLoad === 'ready'
      ? { coOwnerIds: values.coOwnerIds }
      : {}),
    ...(caps.canSetKind ? { kind: values.kind } : {}),
    // The presentation is the organiser's (E2), like the date.
    ...(caps.canSetPresentation && values.writeSide === 'organiser'
      ? { presentation: values.presentation }
      : {}),
    // The reach is the organiser's (E2), sent only once the author touched the picker: absent, the
    // server leaves the stored one alone. Narrower or wider, it never sends the event back to
    // validation and tells nobody.
    ...(offersReach(values, caps) && values.reachTouched ? reachPayload(values) : {}),
    // The form link is the organiser's too (D39, E2): a partner's save carries text only.
    ...(!neutral && caps.canLinkForm && values.writeSide === 'organiser'
      ? { linkedFormId: values.linkedFormId.trim() || null }
      : {}),
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
    presentation: 'association',
    linkedFormId: '',
    coOwnerIds: [],
    coOwnersLoad: 'ready',
    coOwnerStates: [],
    targetAssociationId: '',
    writeSide: 'organiser',
    reach: emptyReachDraft(),
    reachRequired: true,
    reachTouched: false,
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
    presentation: ev.presentation ?? 'association',
    linkedFormId: ev.linkedFormId ?? '',
    // The ACCEPTED ones only, which is why the list is not sendable until the states arrive.
    coOwnerIds: (ev.coOwners ?? []).map((co) => co.associationId),
    coOwnersLoad: 'loading',
    coOwnerStates: [],
    targetAssociationId: ev.associationId,
    writeSide: 'unknown',
    reach: ev.reach ? reachDraftFrom(ev.reach) : emptyReachDraft(),
    reachRequired: !!ev.reach,
    reachTouched: false,
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
  presentation?: AssociationCalendarEventPresentation;
  linkedFormId?: string | null;
  coOwners?: { associationId: string }[];
  /** The reach an institution chose; `null` or absent when it carries none. */
  reach?: InstitutionReach | null;
}
