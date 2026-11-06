import { BadRequestException, Logger } from '@nestjs/common';
import {
  FORM_GUEST_IDENTITY_MISSING,
  FORM_GUEST_IDENTITY_NOT_ASKED,
  formRefusal,
} from './answer-bounds';

/**
 * A GUEST'S NAME AND E-MAIL, ONLY WHEN THE FORM ASKS (owner, 2026-11-06).
 *
 * A guest answering a PUBLIC form at `/f/:id` has no account, and by default is asked NOTHING about
 * who they are. The form's creator may ask for a last name, a first name and an e-mail - three
 * independent choices (`forms.guestFields`, migration 138), each REQUIRED once asked - so an
 * organiser can find who ordered. A member is never asked: Canari knows who they are, and an answer
 * that carries these fields from a member is refused, never silently dropped.
 *
 * THE E-MAIL IS NEVER ASKED TWICE. A guest who pays online already types an address for Lydia. When
 * the form asks for the e-mail, that one address is both: stored with the answer and sent to Lydia
 * (`guestPayerEmail`). When it does not, the address is asked only at the payment step and never
 * stored, as before (decision PP2).
 *
 * Nothing here is stored that the form did not ask for: a field the form does not ask is refused,
 * so the columns hold exactly what the creator chose to collect. Register row C8 and the privacy
 * policy say so.
 */

const logger = new Logger('GuestIdentity');

/** The fields a form may ask of a guest, in the order the page and the export show them. */
export const GUEST_IDENTITY_FIELDS = ['lastName', 'firstName', 'email'] as const;
export type GuestIdentityField = (typeof GUEST_IDENTITY_FIELDS)[number];

/** What a guest's answer may carry, as the DTO receives it. */
export interface GuestIdentityInput {
  guestLastName?: string;
  guestFirstName?: string;
  guestEmail?: string;
}

/** What is stored on the answer: the value typed, trimmed, for an asked field; null otherwise. */
export interface GuestIdentity {
  guestLastName: string | null;
  guestFirstName: string | null;
  guestEmail: string | null;
}

/** The input property and the stored column of each field: one name, both sides. */
const PROPERTY: Record<GuestIdentityField, keyof GuestIdentityInput & keyof GuestIdentity> = {
  lastName: 'guestLastName',
  firstName: 'guestFirstName',
  email: 'guestEmail',
};

/** The identity of every answer that carries none: a member's, and a guest's on a form that asks nothing. */
export const NO_GUEST_IDENTITY: GuestIdentity = {
  guestLastName: null,
  guestFirstName: null,
  guestEmail: null,
};

/**
 * The fields a form asks, canonical: known names only, each once, in {@link GUEST_IDENTITY_FIELDS}
 * order. A stored value this code does not know is dropped and accused: a field it cannot name is a
 * field it cannot ask.
 */
export function askedGuestFields(stored: unknown): GuestIdentityField[] {
  if (stored == null) return [];
  if (!Array.isArray(stored)) {
    logger.warn(`[FORMS] guestFields is not a list (${typeof stored}): read as asking nothing`);
    return [];
  }
  const unknown = stored.filter((f) => !(GUEST_IDENTITY_FIELDS as readonly unknown[]).includes(f));
  if (unknown.length > 0) {
    logger.warn(`[FORMS] guestFields holds unknown names ${JSON.stringify(unknown)}: dropped`);
  }
  return GUEST_IDENTITY_FIELDS.filter((f) => stored.includes(f));
}

/**
 * What a save stores in `forms.guestFields`: the canonical list, or null when it asks nothing - so
 * "asks nothing" has ONE stored shape, the one every form before migration 138 already has.
 */
export function storedGuestFields(input: unknown): GuestIdentityField[] | null {
  const asked = askedGuestFields(input);
  return asked.length > 0 ? asked : null;
}

/** Whether an answer carries any of the three fields, empty strings included. */
export function carriesGuestIdentity(input: GuestIdentityInput): boolean {
  return Object.values(PROPERTY).some((p) => input[p] !== undefined && input[p] !== null);
}

/**
 * What one answer stores, judged against what the form asks. A member's answer that carries any of
 * the fields is a 400 (the member page never sends them); a guest's must carry every asked field,
 * non-blank, and none that is not asked. The DTO bounds the lengths and the e-mail's shape.
 */
export function guestIdentityFor(
  asked: readonly GuestIdentityField[],
  input: GuestIdentityInput,
  origin: 'member' | 'guest',
  formId: string
): GuestIdentity {
  if (origin === 'member') {
    if (carriesGuestIdentity(input)) {
      logger.warn(
        `[FORMS] member answer refused: it carries guest identity form=${formId.slice(0, 8)}`
      );
      throw new BadRequestException({
        code: FORM_GUEST_IDENTITY_NOT_ASKED,
        message: 'A member is never asked for a guest name or e-mail.',
      });
    }
    return NO_GUEST_IDENTITY;
  }
  const identity: GuestIdentity = { ...NO_GUEST_IDENTITY };
  for (const field of GUEST_IDENTITY_FIELDS) {
    const property = PROPERTY[field];
    const raw = input[property];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!asked.includes(field)) {
      if (value !== '') {
        logger.warn(
          `[FORMS] guest answer refused: ${field} sent but not asked form=${formId.slice(0, 8)}`
        );
        throw formRefusal(
          FORM_GUEST_IDENTITY_NOT_ASKED,
          `This form does not ask a guest for ${field}.`
        );
      }
      continue;
    }
    if (value === '') {
      logger.log(`[FORMS] guest answer refused: ${field} missing form=${formId.slice(0, 8)}`);
      throw formRefusal(FORM_GUEST_IDENTITY_MISSING, `This form asks a guest for ${field}.`);
    }
    identity[property] = value;
  }
  return identity;
}

/**
 * The address Lydia's request goes to for a guest: the e-mail the form asked, when it asked one (one
 * address, typed once), else the one typed at the payment step, never stored.
 */
export function guestPayerEmail(
  identity: GuestIdentity,
  payerEmail: string | undefined
): string | undefined {
  return identity.guestEmail ?? payerEmail;
}

/**
 * The name a guest's answer is shown and exported under, when the guest gave one: "First Last",
 * or the one of the two that was asked. Null when no name was given (the reference, or "Guest",
 * then stands for it).
 */
export function guestDisplayName(row: {
  guestFirstName?: string | null;
  guestLastName?: string | null;
}): string | null {
  const name = [row.guestFirstName, row.guestLastName].filter(Boolean).join(' ');
  return name === '' ? null : name;
}
