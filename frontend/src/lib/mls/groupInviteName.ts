import type { Conversation } from '$lib/types';
import { stripInvisible } from '$lib/utils/users/visibleText';

/**
 * THE NAME A GROUP INVITE LINK CARRIES, IN ITS `#fragment` (sealed names, step 3, part 1).
 *
 * Principle 1 of the charter (docs/principes.md, "Vos messages sont à vous"): the server must not
 * know what a group is called. An invite card has to name the group BEFORE its reader is a member,
 * and a member's device is the only place that knows the name - so the sharer's device writes it
 * into the link's fragment, which no browser, WebView or unfurler ever sends in a request (owner,
 * 2026-11-17, docs/wiki/protocols/sealed-names.md#decisions-taken-by-the-owner-2026-11-17).
 *
 * The fragment is `name=<form-encoded name>`, so a later field (a community's, step 5) can sit
 * beside it without a new format.
 */

/** The fragment key the name is written under. */
export const INVITE_NAME_FRAGMENT_KEY = 'name';

/**
 * The most code points a card shows of a fragment's name. The fragment is UNTRUSTED - any holder of
 * the token can write any name there - so a pasted megabyte never reaches a card; 100 is the bound
 * the other names a member types carry (`NICKNAME_MAX_LENGTH`).
 */
export const INVITE_NAME_MAX_CODE_POINTS = 100;

/**
 * The name a member's device puts in a group invite link: the row's name ONLY when a frame of the
 * group dated it (`nameAt`, steps 1 and 2) - the members' own word. An undated row may hold a
 * placeholder (a raw id, the Welcome's guess) or nothing, and a guess must never be handed out as
 * the group's name; such a link carries no name, and its card says so.
 */
export function inviteLinkName(
  row: Pick<Conversation, 'name' | 'nameAt' | 'conversationType'> | null | undefined
): string | null {
  if (!row || (row.conversationType ?? 'group') !== 'group') return null;
  if (row.nameAt === undefined) return null;
  const name = row.name.trim();
  return name === '' ? null : name;
}

/** `url` with the group's name in its fragment, or `url` unchanged when there is no name to carry. */
export function withInviteNameFragment(url: string, name: string | null): string {
  if (name === null) return url;
  return `${url}#${new URLSearchParams({ [INVITE_NAME_FRAGMENT_KEY]: name }).toString()}`;
}

/**
 * What a link's fragment says about the group's name:
 * - `{ name }`: the name the link carries, invisible characters stripped (`cut`: it was longer than
 *   {@link INVITE_NAME_MAX_CODE_POINTS} and only its start is kept);
 * - `{ absent: 'no-fragment' }`: a link with no name - minted by a build older than this one, or for
 *   a group no frame has named yet;
 * - `{ absent: 'empty' }`: a fragment whose name is blank once stripped and trimmed.
 */
export type InviteNameRead = { name: string; cut?: true } | { absent: 'no-fragment' | 'empty' };

/**
 * Reads the name from a fragment (`location.hash`, with or without its `#`). Never throws. The
 * fragment is untrusted input: the controls, bidi overrides and zero-width characters a name must
 * not hold are stripped by the one rule names use (`stripInvisible`), then the length is capped.
 */
export function readInviteNameFragment(hash: string): InviteNameRead {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const value = new URLSearchParams(raw).get(INVITE_NAME_FRAGMENT_KEY);
  if (value === null) return { absent: 'no-fragment' };
  const points = Array.from(stripInvisible(value).trim());
  if (points.length === 0) return { absent: 'empty' };
  if (points.length <= INVITE_NAME_MAX_CODE_POINTS) return { name: points.join('') };
  return { name: points.slice(0, INVITE_NAME_MAX_CODE_POINTS).join('').trim(), cut: true };
}

/** The fragment of `href` (an absolute URL or a path), `''` when it has none or does not parse. */
export function fragmentOf(href: string): string {
  try {
    return new URL(href, 'https://invalid.invalid/').hash;
  } catch {
    return '';
  }
}

/**
 * The name an invite card shows: the fragment's when the link carries one; otherwise the name the
 * server's preview still answers - a LEGACY branch for links minted by builds older than this one,
 * which carry no fragment (docs/wiki/legacy-compatibility.md, "a group invite link with no name in
 * its fragment"). It goes when the server's preview stops naming the group (step 3, a later part).
 * `null` means the card names no group.
 */
export function inviteCardName(read: InviteNameRead, serverName: string | null): string | null {
  if ('name' in read) return read.name;
  const legacy = serverName?.trim() ?? '';
  return legacy === '' ? null : legacy;
}
