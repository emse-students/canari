import { ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as crypto from 'crypto';
import { isUUID } from 'class-validator';
import type { SpaceSelection } from './directory-query';
import type { SpacePair } from '../spaces/reader-spaces';

/**
 * THE AGENDA LINKS A CALENDAR APP OPENS WITH NO IDENTITY (docs/wiki/profiles-and-access.md).
 *
 * SINCE 2026-11-14 ("Respecter les publics", D40 re-decided): a subscription link names its HOLDER.
 * Its token is `<subscription id>.<HMAC of the id>` ({@link agendaSubscriptionToken}), the id a row of
 * `agenda_subscriptions` (migration 173), and the feed it opens is the holder's own signed-in agenda,
 * re-read at every poll. Deleting the row revokes the link; the account erasure deletes it too.
 *
 * THE LEGACY SELECTION LINK (D40 amended 2026-10-06, a dated shim - docs/wiki/legacy-compatibility.md):
 * `sig`, an HMAC of the canonical selection (campus, formation, association), names no one. It is
 * still verified so saved links keep resolving, but it serves only what every reader who could hold
 * it sees: a PAIR as before, any other shape an EMPTY calendar (`legacyAgendaLinkShape`).
 * Rotating the key ends every link of every kind at once.
 */

/** 403 code: the selection names a campus / formation / association and carries no `sig`. */
export const AGENDA_SIGNATURE_REQUIRED = 'AGENDA_SIGNATURE_REQUIRED';
/** 403 code: `sig` is not the signature of THIS selection (tampered, or made for another one). */
export const AGENDA_SIGNATURE_INVALID = 'AGENDA_SIGNATURE_INVALID';
/** 403 code: the signed-in reader asked to sign a selection outside their own spaces. */
export const AGENDA_SELECTION_FORBIDDEN = 'AGENDA_SELECTION_FORBIDDEN';

/** What a signature covers. `from`/`to` are deliberately NOT part of it: the window is free. */
export interface SignedSelection extends SpaceSelection {
  associationId: string | null;
}

const MIN_KEY_LENGTH = 32;
const logger = new Logger('AgendaSignature');

/** One unambiguous string per selection; the format version leaves room to change it later. */
export function canonicalAgendaSelection(sel: SignedSelection): string {
  return `v1|campus=${sel.campus ?? '-'}|formation=${sel.formation ?? '-'}|association=${sel.associationId ?? '-'}`;
}

/** The key, or a 503: an unset key is a deployment fault, never "no signature needed". */
function signingKey(): string {
  const key = process.env.AGENDA_SIGNING_KEY ?? '';
  if (key.length < MIN_KEY_LENGTH) {
    logger.error(`[AGENDA_SIG] AGENDA_SIGNING_KEY is unset or shorter than ${MIN_KEY_LENGTH}`);
    throw new ServiceUnavailableException('Agenda signing is not configured');
  }
  return key;
}

/**
 * Throws the 503 an unset or short `AGENDA_SIGNING_KEY` gets, and nothing otherwise: asked BEFORE a
 * write whose answer needs a signature, so a misconfigured estate writes nothing.
 */
export function assertAgendaSigningKey(): void {
  signingKey();
}

/**
 * Base64url HMAC-SHA256 of `canonical` under `AGENDA_SIGNING_KEY` - THE ONE KEY for every link a
 * calendar app opens without an identity (an agenda selection, a booking's `.ics`). Each caller
 * prefixes its own canonical form, so a signature made for one kind of link can never be read as
 * another's. Rotating the key ends every saved link of every kind at once - that is the revocation.
 */
export function signWithAgendaKey(canonical: string): string {
  return crypto.createHmac('sha256', signingKey()).update(canonical).digest('base64url');
}

/** Constant-time comparison of `received` with the signature of `canonical`; false when absent. */
export function agendaKeySignatureMatches(
  canonical: string,
  received: string | undefined
): boolean {
  const got = Buffer.from(received?.trim() ?? '');
  const expected = Buffer.from(signWithAgendaKey(canonical));
  return got.length === expected.length && crypto.timingSafeEqual(expected, got);
}

/** Base64url HMAC-SHA256 of the canonical selection. */
export function signAgendaSelection(sel: SignedSelection): string {
  return signWithAgendaKey(canonicalAgendaSelection(sel));
}

/** Constant-time check; 403 `AGENDA_SIGNATURE_REQUIRED` when absent, `..._INVALID` when wrong. */
export function assertAgendaSignature(sel: SignedSelection, sig: string | undefined): void {
  const received = sig?.trim();
  if (!received) {
    throw new ForbiddenException({
      code: AGENDA_SIGNATURE_REQUIRED,
      message: 'This agenda selection needs a signed link: subscribe again from the Canari app',
    });
  }
  const expected = Buffer.from(signAgendaSelection(sel));
  const got = Buffer.from(received);
  if (got.length !== expected.length || !crypto.timingSafeEqual(expected, got)) {
    logger.warn(`[AGENDA_SIG] refused a signature for ${canonicalAgendaSelection(sel)}`);
    throw new ForbiddenException({
      code: AGENDA_SIGNATURE_INVALID,
      message: 'The signature does not match this agenda selection',
    });
  }
}

/**
 * THE SIGNED LINK OF ONE EVENT'S `.ics` (owner, 2026-11-02): the "add to my calendar" link a phone's
 * browser opens, with no identity. Like a selection it is a capability - the server signs it for a
 * reader who already sees the event (served on the event as `icsSig`), and the route refuses it
 * unsigned. Its own canonical prefix, so neither kind of signature can be read as the other.
 */
export function canonicalEventIcs(eventId: string): string {
  return `v1|event-ics|event=${eventId}`;
}

/** The signature of event `eventId`'s single-event `.ics` link. */
export function signEventIcs(eventId: string): string {
  return signWithAgendaKey(canonicalEventIcs(eventId));
}

/**
 * The log tag of a refused single-event `.ics` read - unsigned or wrongly signed. Counted after a
 * release to measure the links still saved in the old, unsigned form; no grace period applies.
 */
export const EVENT_ICS_REFUSED_TAG = '[AGENDA_ICS_REFUSED]';

/**
 * `rows` with `icsSig` on each VALIDATED event: what the client puts in that event's "add to my
 * calendar" link. Only a validated event has a single-event `.ics` (the feed serves no other).
 */
export function withEventIcsSig<T extends { id: string; status?: string }>(
  rows: T[]
): Array<T & { icsSig?: string }> {
  return rows.map((row) =>
    row.status === 'validated' ? { ...row, icsSig: signEventIcs(row.id) } : row
  );
}

/** `withEventIcsSig` for one event a route answers on its own (a post's or a form's linked event). */
export function withOneEventIcsSig<T extends { id: string; status?: string }>(
  row: T | null
): (T & { icsSig?: string }) | null {
  return row ? withEventIcsSig([row])[0] : null;
}

/** Constant-time check of an event `.ics` link's signature; false when absent or wrong. */
export function eventIcsSignatureMatches(eventId: string, sig: string | undefined): boolean {
  return agendaKeySignatureMatches(canonicalEventIcs(eventId), sig);
}

/**
 * The canonical string of one subscription's link: its own `v2|subscription=` prefix, so neither a
 * selection's signature nor an event's can be read as a subscription token, nor the reverse.
 */
export function canonicalAgendaSubscription(subscriptionId: string): string {
  return `v2|subscription=${subscriptionId}`;
}

/** The token a subscription link carries: `<id>.<base64url HMAC of the canonical id>`. */
export function agendaSubscriptionToken(subscriptionId: string): string {
  return `${subscriptionId}.${signWithAgendaKey(canonicalAgendaSubscription(subscriptionId))}`;
}

/**
 * The subscription id a token names, once its HMAC is checked (constant time) - or null for a token
 * that is malformed, names no uuid or is wrongly signed. Whether the row still EXISTS (revoked, erased)
 * is the caller's question: a correct signature proves only that the server minted it.
 */
export function verifiedAgendaSubscriptionId(token: string | undefined): string | null {
  const raw = token?.trim() ?? '';
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const id = raw.slice(0, dot);
  if (!isUUID(id)) return null;
  return agendaKeySignatureMatches(canonicalAgendaSubscription(id), raw.slice(dot + 1)) ? id : null;
}

/** The WARN tag of a refused subscription token (unknown, revoked or wrongly signed). */
export const AGENDA_SUBSCRIPTION_REFUSED_TAG = '[AGENDA_SUBSCRIPTION_REFUSED]';

/**
 * The WARN tag of a legacy `sig` link seen: ONE line per distinct link per process per UTC day
 * ({@link LegacyLinkSightings}), the count its removal waits on.
 */
export const AGENDA_LEGACY_LINK_TAG = '[AGENDA_LEGACY_LINK]';

/**
 * A legacy link's name in the logs: the first 8 hex characters of SHA-256 of its `sig`. A `sig` names
 * no one (it signs a selection), and its hash does not let the link be rebuilt.
 */
export function legacyLinkFingerprint(sig: string): string {
  return crypto.createHash('sha256').update(sig.trim()).digest('hex').slice(0, 8);
}

/**
 * WHICH LEGACY LINKS THIS PROCESS HAS ALREADY REPORTED TODAY. A calendar app polls its link about a
 * hundred times a day; the removal of the shim waits on how many distinct LINKS are still polled, so
 * each is logged once per UTC day and per process. The set is forgotten when the day changes (it
 * holds one day's links at most). N replicas log a link up to N times a day: count distinct
 * `link=` values, never lines. It decides nothing but whether to write a log line.
 */
export class LegacyLinkSightings {
  private day = '';
  private readonly seen = new Set<string>();

  /** True the first time `link` is offered on `day` (a `YYYY-MM-DD`), false after. */
  firstToday(link: string, day: string): boolean {
    if (day !== this.day) {
      this.day = day;
      this.seen.clear();
    }
    if (this.seen.has(link)) return false;
    this.seen.add(link);
    return true;
  }
}

/**
 * What a legacy selection link names: a space (`pair`, with or without an association) - the one
 * shape every holder of which was in that space, so the one that still serves events - or a
 * `campus` alone (the staff link), a `formation` alone (signed before the 2026-10-07 tightening) or
 * an `association` alone, which serve an empty calendar (owner's review, 2026-11-14).
 */
export type LegacyAgendaLinkShape = 'pair' | 'campus' | 'formation' | 'association';

/** The shape of a legacy selection (see {@link LegacyAgendaLinkShape}). */
export function legacyAgendaLinkShape(sel: SpaceSelection): LegacyAgendaLinkShape {
  if (sel.campus !== null && sel.formation !== null) return 'pair';
  if (sel.campus !== null) return 'campus';
  if (sel.formation !== null) return 'formation';
  return 'association';
}

/**
 * May a reader whose spaces are `spaces` be handed a signature for `sel`? Only one of
 * their spaces, a campus AND a formation (user, 2026-10-07). An association adds
 * no condition of its own - membership does not matter (user, 2026-10-06) and its page is public;
 * the caller checks that it exists.
 *
 * `campusWide` is the campus of a reader tied to no formation (`campusWideReaderCampus`, EMSE staff,
 * user 2026-10-07): they have no space, and may follow their OWN campus whole - `campus=<own>` with
 * no formation, every formation of it. A formation, or any other campus, stays refused.
 */
export function selectionWithinSpaces(
  sel: SpaceSelection,
  spaces: readonly SpacePair[],
  campusWide: string | null = null
): boolean {
  if (sel.campus === null && sel.formation === null) return true;
  if (campusWide !== null && spaces.length === 0) {
    return sel.formation === null && sel.campus === campusWide;
  }
  // A student follows ONE space, a campus AND a formation of theirs (user, 2026-10-07); a wider
  // selection is refused - an event across campuses arrives by co-organiser partnership (D39).
  if (sel.campus === null || sel.formation === null) return false;
  return spaces.some((s) => s.campus === sel.campus && s.formation === sel.formation);
}
