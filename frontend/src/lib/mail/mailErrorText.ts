import { m } from '$lib/paraglide/messages';
import type { MailErrorKind } from './mailErrors';
import type { PasswordAskReason } from './mailSession';

/**
 * EVERY TYPED MAIL FAILURE, IN THE READER'S WORDS (docs/wiki/mail-client-transport.md#as-built---lot-3).
 *
 * The screens switch on `MailError.kind` (D7) and on nothing else; this table is the ONE place a kind
 * becomes a sentence, so a kind added to `mailErrors.ts` without a sentence fails the compiler (the
 * table is a `Record` over the union). The sentences say the outcome and what the reader can do,
 * never a code or a layer (durable rules: user-visible text shows no technical internals); the code
 * stays in the log.
 */

const ERROR_TEXT: Readonly<Record<MailErrorKind, () => string>> = {
  bad_credentials: m.mail_error_bad_credentials,
  password_change_required: m.mail_error_password_change_required,
  account_closed: m.mail_error_account_closed,
  account_unavailable: m.mail_error_account_unavailable,
  maintenance: m.mail_error_maintenance,
  session_expired: m.mail_error_session_expired,
  not_found: m.mail_error_not_found,
  invalid_query: m.mail_error_invalid_query,
  too_large: m.mail_error_too_large,
  quota_exceeded: m.mail_error_quota_exceeded,
  address_unknown: m.mail_error_address_unknown,
  not_eligible: m.mail_error_not_eligible,
  not_signed_in: m.mail_error_not_signed_in,
  transport: m.mail_error_transport,
  server: m.mail_error_server,
  internal: m.mail_error_internal,
  not_sent: m.mail_error_not_sent,
  incompatible: m.mail_error_incompatible,
};

/** The sentence for a failure of `kind`. */
export function mailErrorText(kind: MailErrorKind): string {
  return ERROR_TEXT[kind]();
}

/**
 * Whether the same press can succeed again by itself (a network or server hiccup, maintenance, a
 * request the connection never sent): the screen then offers "Réessayer". A refused password, a
 * closed account, a bad search or a server this build cannot speak to (`incompatible`, until an
 * update) are not retried as they are - something else changes first.
 */
export function mailErrorRetryable(kind: MailErrorKind): boolean {
  return (
    kind === 'transport' ||
    kind === 'server' ||
    kind === 'maintenance' ||
    kind === 'internal' ||
    kind === 'not_sent'
  );
}

const ASK_TEXT: Readonly<Record<PasswordAskReason, () => string>> = {
  not_remembered: m.mail_ask_not_remembered,
  password_refused: m.mail_ask_password_refused,
  remembered_unopenable: m.mail_ask_remembered_unopenable,
  device_locked: m.mail_ask_device_locked,
  session_refused: m.mail_ask_session_refused,
};

/** Why the sign-in screen asks for the password again, in the reader's words. */
export function mailAskText(reason: PasswordAskReason): string {
  return ASK_TEXT[reason]();
}
