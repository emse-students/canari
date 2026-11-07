import { m } from '$lib/paraglide/messages';
import { normalizePayerEmail } from '$lib/payments/payerEmail';
import { GUEST_EMAIL_MAX_LENGTH, GUEST_NAME_MAX_LENGTH } from './answerBounds';

/**
 * A GUEST'S NAME AND E-MAIL, ONLY WHEN THE FORM ASKS (owner, 2026-11-06) - the client half of
 * `apps/social-service/src/forms/guest-identity.ts`.
 *
 * A guest on a public form's link is asked nothing about who they are by default. The creator ticks
 * any of last name, first name, e-mail (`Form.guestFields`); each ticked field is then required on
 * `/f/:id`. A member is never asked. The e-mail, when asked, is ALSO the address Lydia's request
 * goes to, so the payment step does not ask for it a second time.
 */

/** The fields a form may ask of a guest, in the order the page and the settings show them. */
export const GUEST_IDENTITY_FIELDS = ['lastName', 'firstName', 'email'] as const;
export type GuestIdentityField = (typeof GUEST_IDENTITY_FIELDS)[number];

/** What a guest typed, by field; a field the form does not ask stays empty and is never sent. */
export type GuestIdentityValues = Record<GuestIdentityField, string>;

/** An empty identity, the page's starting state and its state after "answer again". */
export function emptyGuestIdentity(): GuestIdentityValues {
  return { lastName: '', firstName: '', email: '' };
}

/** The asked fields, canonical: known names only, in page order. */
export function askedGuestFields(
  stored: readonly string[] | null | undefined
): GuestIdentityField[] {
  return GUEST_IDENTITY_FIELDS.filter((f) => stored?.includes(f));
}

/** The label of one field, for the settings checkboxes and the fill page's inputs alike. */
export function guestFieldLabel(field: GuestIdentityField): string {
  switch (field) {
    case 'lastName':
      return m.form_guest_identity_last_name();
    case 'firstName':
      return m.form_guest_identity_first_name();
    case 'email':
      return m.form_guest_identity_email();
  }
}

/** The input's maximum length, the server's bound (`libs/contracts/form-answers.json`). */
export function guestFieldMaxLength(field: GuestIdentityField): number {
  return field === 'email' ? GUEST_EMAIL_MAX_LENGTH : GUEST_NAME_MAX_LENGTH;
}

/**
 * What is wrong with one asked field, or null: empty, or an e-mail the server would refuse. Said
 * on the field itself, before anything is sent.
 */
export function guestFieldProblem(field: GuestIdentityField, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return m.form_guest_identity_required();
  if (field === 'email' && !normalizePayerEmail(trimmed)) return m.payer_email_invalid();
  return null;
}

/** The first asked field with a problem, or null when every asked field is filled correctly. */
export function firstGuestFieldProblem(
  asked: readonly GuestIdentityField[],
  values: GuestIdentityValues
): GuestIdentityField | null {
  return asked.find((f) => guestFieldProblem(f, values[f]) !== null) ?? null;
}

/** The wire properties of the submit body: only the asked fields, trimmed. */
export function guestIdentityPayload(
  asked: readonly GuestIdentityField[],
  values: GuestIdentityValues
): { guestLastName?: string; guestFirstName?: string; guestEmail?: string } {
  return {
    ...(asked.includes('lastName') ? { guestLastName: values.lastName.trim() } : {}),
    ...(asked.includes('firstName') ? { guestFirstName: values.firstName.trim() } : {}),
    ...(asked.includes('email') ? { guestEmail: values.email.trim() } : {}),
  };
}

/**
 * Whether the payment step must still ask for an address: only when the answer is paid online AND
 * the form did not already ask the e-mail (which is then the address Lydia uses - never asked twice).
 */
export function payerPromptNeeded(
  paysOnline: boolean,
  asked: readonly GuestIdentityField[]
): boolean {
  return paysOnline && !asked.includes('email');
}

/**
 * How strongly the settings recommend asking a guest: not at all on a form that is not public or
 * already asks something, more strongly when the form charges ("retrouver qui a commandé").
 */
export function guestFieldsAdvice(
  isPublic: boolean,
  charges: boolean,
  asked: readonly string[]
): 'none' | 'suggested' | 'paid' {
  if (!isPublic || asked.length > 0) return 'none';
  return charges ? 'paid' : 'suggested';
}

/** The name a guest's answer is filed under when the guest gave one, else null. */
export function guestDisplayName(row: {
  guestFirstName?: string | null;
  guestLastName?: string | null;
}): string | null {
  const name = [row.guestFirstName, row.guestLastName].filter(Boolean).join(' ');
  return name === '' ? null : name;
}
