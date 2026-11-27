import { Log } from '$lib/utils/Log';
import { HttpProtocolError } from './http1';
import { ZimbraFault, ZimbraUnreadableAnswer } from './soapClient';
import { MailTlsError } from './tlsConnection';
import { MailTransportError } from './transport';

/**
 * WHY A MAIL CALL FAILED, TYPED WHERE IT IS THROWN (docs/wiki/mail-client.md D7).
 *
 * Every layer below already throws a type: `ZimbraFault` by its `Detail.Error.Code`, the
 * transport, TLS and HTTP errors by `kind`. {@link classifyMailFailure} turns those into ONE
 * {@link MailError} at the single seam every call goes through (`MailSession`), by class and code -
 * never by a message - so the screens switch on `kind` and nothing else.
 */

export type MailErrorKind =
  /** The address or the password is wrong (`account.AUTH_FAILED`). Never retried. */
  | 'bad_credentials'
  /** The school requires a new password before the next sign-in (`account.CHANGE_PASSWORD`). */
  | 'password_change_required'
  /** The account is closed, inactive or gone (D8: the device erases what it kept). */
  | 'account_closed'
  /** The mailbox is in maintenance: temporary, nothing is erased. */
  | 'maintenance'
  /** The session ended and could not be renewed: the password is asked again. */
  | 'session_expired'
  /** The message, conversation or folder no longer exists (moved or deleted elsewhere). */
  | 'not_found'
  /** The search query is not one Zimbra can parse. */
  | 'invalid_query'
  /** The message or the attachment is over the server's size limit. */
  | 'too_large'
  /** The mailbox is full. */
  | 'quota_exceeded'
  /** The Canari account's identity carries no school address: there is no mailbox to sign in to. */
  | 'address_unknown'
  /** The address is not on an eligible domain (D1): refused before any byte is sent. */
  | 'not_eligible'
  /** A call was made with no session. */
  | 'not_signed_in'
  /** The mailbox could not be reached, or the connection failed (relay, socket, TLS, HTTP framing). */
  | 'transport'
  /** The server answered with a fault this client does not name, or an unreadable answer. */
  | 'server'
  /** A throw no layer typed: a bug, logged as one. */
  | 'internal';

/** A mail failure, typed: callers read `kind` (and `code` for a log), never the message. */
export class MailError extends Error {
  constructor(
    readonly kind: MailErrorKind,
    /** The Zimbra fault code or the lower layer's kind, for logs only. */
    readonly code: string,
    readonly cause?: unknown
  ) {
    super(`mail ${kind} (${code})`);
    this.name = 'MailError';
  }
}

/**
 * Zimbra fault codes, as Zimbra 9 throws them, to the kind each one means. A code not listed is
 * `server`. The list is the measured ones (docs/wiki/mail-client-transport.md) plus the documented
 * codes of the calls this client makes.
 */
const FAULT_KINDS: Readonly<Record<string, MailErrorKind>> = {
  'account.AUTH_FAILED': 'bad_credentials',
  'account.CHANGE_PASSWORD': 'password_change_required',
  'account.ACCOUNT_INACTIVE': 'account_closed',
  'account.NO_SUCH_ACCOUNT': 'account_closed',
  'account.MAINTENANCE_MODE': 'maintenance',
  'service.AUTH_REQUIRED': 'session_expired',
  'service.AUTH_EXPIRED': 'session_expired',
  'mail.NO_SUCH_MSG': 'not_found',
  'mail.NO_SUCH_CONV': 'not_found',
  'mail.NO_SUCH_FOLDER': 'not_found',
  'mail.NO_SUCH_ITEM': 'not_found',
  'mail.NO_SUCH_PART': 'not_found',
  'mail.NO_SUCH_UPLOAD': 'not_found',
  'mail.QUERY_PARSE_ERROR': 'invalid_query',
  'mail.MESSAGE_TOO_BIG': 'too_large',
  'mail.UPLOAD_REJECTED': 'too_large',
  'mail.QUOTA_EXCEEDED': 'quota_exceeded',
};

/** The kind of a Zimbra fault code. */
export function faultKind(code: string): MailErrorKind {
  return FAULT_KINDS[code] ?? 'server';
}

/**
 * Turns whatever a lower layer threw into a {@link MailError}, by CLASS and CODE. Anything none of
 * them typed is `internal` and logged as a defect: a failure this deliberate path did not classify
 * is the visible end of something upstream.
 */
export function classifyMailFailure(err: unknown): MailError {
  if (err instanceof MailError) return err;
  if (err instanceof ZimbraFault) return new MailError(faultKind(err.code), err.code, err);
  if (err instanceof ZimbraUnreadableAnswer) {
    return new MailError('server', `unreadable-${err.status}`, err);
  }
  if (err instanceof MailTransportError) return new MailError('transport', err.kind, err);
  if (err instanceof MailTlsError) return new MailError('transport', `tls-${err.kind}`, err);
  if (err instanceof HttpProtocolError) return new MailError('transport', `http-${err.kind}`, err);
  Log.w('MAIL', 'ERROR: a mail call failed with a throw no layer typed', err);
  return new MailError('internal', 'untyped', err);
}
