import { m } from '$lib/paraglide/messages';
import type {
  AssociationCalendarEventKind,
  CreateAssociationCalendarEventPayload,
  UpdateAssociationCalendarEventPayload,
} from '$lib/associations/api';

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
  coOwnerIds: string[];
  /** `''` on a surface that does not choose an association. */
  targetAssociationId: string;
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
    coOwnerIds: values.coOwnerIds,
    ...(caps.canSetKind ? { kind: values.kind } : {}),
    ...(caps.canLinkForm ? { linkedFormId: values.linkedFormId.trim() || null } : {}),
  };
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * An instant as the `datetime-local` text an input shows, in the viewer's own zone.
 *
 * Both surfaces carried this and its `pad` helper verbatim, which is the same duplication one level
 * down: two copies of the rule that decides what an edit's start time LOOKS like.
 */
export function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A blank form, starting on the current hour - the defaults a NEW entry opens with, decided once. */
export function blankEventFormValues(): EventFormValues {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  return {
    title: '',
    description: '',
    start: toDatetimeLocalValue(now.toISOString()),
    end: '',
    kind: 'event',
    linkedFormId: '',
    coOwnerIds: [],
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
    coOwnerIds: (ev.coOwners ?? []).map((co) => co.associationId),
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
