import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import type { MailAddress, MailMessage, OutgoingMessage } from './mailTypes';

/**
 * REPLY, REPLY-ALL AND FORWARD, PREFILLED (docs/wiki/mail-client-transport.md#as-built---lot-2).
 *
 * Pure: each builds the {@link OutgoingMessage} the composer opens with - recipients, subject,
 * the quoted original in text and HTML, and what the message answers (so Zimbra threads it and
 * flags the original). The words a reader sees in the quote (the attribution line, the forwarded
 * header) are Paraglide strings in the app's locale; `Re:` and `Fwd:` are not translated, as in
 * every mail client, because other clients recognise them to thread.
 */

const REPLY_PREFIX = 'Re: ';
const FORWARD_PREFIX = 'Fwd: ';
/** A subject already marked as a reply (in the forms French and English clients write). */
const REPLIED = /^\s*(re|ré|aw|sv)\s*:/i;
/** A subject already marked as a forward. */
const FORWARDED = /^\s*(fwd?|tr|wg)\s*:/i;

/** A message with nothing in it: what "new message" opens. */
export function emptyMessage(): OutgoingMessage {
  return {
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    text: '',
    html: null,
    attachments: [],
    forwardedParts: [],
    origin: null,
    draftId: null,
  };
}

/** `Name <address>`, or the address alone. */
export function formatAddress(address: MailAddress): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

/** Text made safe to place in HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Plain text as HTML: escaped, line breaks kept. */
export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * A readable text of an HTML body, for the plain-text half of a reply to a mail that only had HTML:
 * scripts and styles dropped, block ends as line breaks, tags removed, the common entities decoded.
 * Never rendered - it is the text a mail client without HTML shows.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
      if (entity[0] === '#') {
        const code =
          entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return ENTITIES[entity.toLowerCase()] ?? whole;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Every line of `text` prefixed with `> `, the plain-text quote. */
export function quoteLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.startsWith('>') ? `>${line}` : `> ${line}`))
    .join('\n');
}

/** The original's body as text. */
function bodyText(original: MailMessage): string {
  if (original.text !== null) return original.text;
  if (original.html !== null) return htmlToText(original.html);
  return original.fragment;
}

/** The original's body as HTML. */
function bodyHtml(original: MailMessage): string {
  return original.html ?? textToHtml(bodyText(original));
}

function formatDate(ms: number): string {
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'long', timeStyle: 'short' }).format(
    new Date(ms)
  );
}

/** `subject` with `prefix`, unless it already carries one of `marked`. */
function prefixed(subject: string, prefix: string, marked: RegExp): string {
  return marked.test(subject) ? subject : `${prefix}${subject}`;
}

/** `addresses` without `exclude` (case-insensitive) and without duplicates. */
function distinct(addresses: MailAddress[], exclude: Set<string>): MailAddress[] {
  const out: MailAddress[] = [];
  for (const address of addresses) {
    const key = address.address.toLowerCase();
    if (exclude.has(key)) continue;
    exclude.add(key);
    out.push(address);
  }
  return out;
}

/**
 * A reply to `original` (`reply_all` also answers its other recipients), written by `self` (the
 * signed-in address, never among the recipients). The reply goes to the original's `Reply-To` when
 * it named one, otherwise its sender - and to its recipients when `self` sent it (a reply from Sent).
 */
export function replyMessage(
  original: MailMessage,
  mode: 'reply' | 'reply_all',
  self: string
): OutgoingMessage {
  const me = self.toLowerCase();
  const fromSelf = original.from?.address.toLowerCase() === me;
  const primary = fromSelf
    ? original.to
    : original.replyTo.length
      ? original.replyTo
      : original.from
        ? [original.from]
        : [];
  const seen = new Set<string>([me]);
  const to = distinct(primary, seen);
  const cc = mode === 'reply_all' ? distinct([...original.to, ...original.cc], seen) : [];
  const attribution = m.mail_quote_attribution({
    date: formatDate(original.date),
    sender: original.from ? formatAddress(original.from) : '',
  });
  return {
    ...emptyMessage(),
    to,
    cc,
    subject: prefixed(original.subject, REPLY_PREFIX, REPLIED),
    text: `\n\n${attribution}\n${quoteLines(bodyText(original))}`,
    html:
      `<br><br><div>${escapeHtml(attribution)}</div>` +
      `<blockquote type="cite">${bodyHtml(original)}</blockquote>`,
    origin: { kind: 'reply', messageId: original.id, messageIdHeader: original.messageIdHeader },
  };
}

/**
 * A forward of `original`: no recipient yet, its header block and body below the reader's text, and
 * its attachments carried by reference (`forwardedParts` - never downloaded and uploaded again).
 */
export function forwardMessage(original: MailMessage): OutgoingMessage {
  const header: string[] = [
    m.mail_forward_header(),
    original.from ? m.mail_forward_from({ value: formatAddress(original.from) }) : null,
    m.mail_forward_date({ value: formatDate(original.date) }),
    m.mail_forward_subject({ value: original.subject }),
    original.to.length
      ? m.mail_forward_to({ value: original.to.map(formatAddress).join(', ') })
      : null,
  ].filter((line): line is NonNullable<typeof line> => line !== null);
  return {
    ...emptyMessage(),
    subject: prefixed(original.subject, FORWARD_PREFIX, FORWARDED),
    text: `\n\n${header.join('\n')}\n\n${bodyText(original)}`,
    html:
      `<br><br><div>${header.map(escapeHtml).join('<br>')}</div><br>` +
      `<div>${bodyHtml(original)}</div>`,
    // Inline images too: the forwarded HTML names them by `cid:`, and an image carried as an
    // attachment is better than one lost.
    forwardedParts: original.attachments.map((a) => ({ messageId: a.messageId, part: a.part })),
    origin: { kind: 'forward', messageId: original.id, messageIdHeader: original.messageIdHeader },
  };
}
