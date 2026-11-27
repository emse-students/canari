/**
 * The label of an UNNAMED group conversation: its other members' first names (owner, 2026-11-17).
 *
 * A group created without a name stores none - not on the server, not in an MLS statement - and
 * every device draws the label itself from two things it already holds: the group's ratchet tree
 * (who is in it) and its own display-name cache (what they are called). Nothing about the label
 * ever leaves the device, which is what principle 1 asks of a group's name (the sealed-names
 * entry, docs/wiki/backlog.d/p1-encrypt-the-names-of-groups-communities-and-salons.md), and the
 * label follows the members because the tree does.
 *
 * WHY THE TREE AND NOT THE SERVER'S ROSTER. Every member's device holds the SAME tree at the same
 * epoch, so the same set of people is named on all of them; the server's roster is a routing table
 * read at a moment, and two devices reading it a second apart can disagree. The ORDER is the first
 * names' (then the ids'), never the tree's leaf order, so it does not depend on who joined first.
 *
 * docs/wiki/frontend/modules/chat.md#one-new-discussion-panel holds the decision.
 */

import { m } from '$lib/paraglide/messages';
import { canonicalUserId, canonicalUserOf } from '$lib/mls-client/leafIdentity';

/** The most first names a label spells out; past it, two are named and the rest counted. */
const UNNAMED_GROUP_SHOWN_NAMES = 3;

/**
 * The people a group's tree holds, one entry per person whatever their number of devices, in
 * canonical form and sorted - a leaf that names nobody (`canonicalUserOf` refuses it) is dropped.
 */
export function memberUserIdsOfTree(leafIdentities: readonly string[]): string[] {
  const users = new Set<string>();
  for (const identity of leafIdentities) {
    const user = canonicalUserOf(identity);
    if (user) users.add(user);
  }
  return [...users].sort();
}

/**
 * The first-level key a label's names are ordered by: Unicode NFD with every combining mark removed,
 * lower-cased - so "Émile" sorts among the E and "bob" beside "Bob". The rule of
 * `libs/contracts/unnamed-group-label.cases.json`, which Rust's `label_collation_key` (the push
 * drawn while the app is dead) answers too.
 */
function labelCollationKey(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * The characters a label's name is trimmed of, LISTED rather than left to each language's `trim`:
 * JavaScript's keeps U+0085 (NEXT LINE) and strips U+FEFF (the BOM), Rust's does the reverse, so a
 * name carrying either would be labelled differently by the app and by the push drawn while it is
 * dead. The union of both: ASCII tab to carriage return, space, U+0085, U+00A0, U+1680,
 * U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF - Rust's `is_label_space` holds
 * the same list, and `libs/contracts/unnamed-group-label.cases.json` asserts it on both.
 */
const LABEL_SPACE =
  '[\\t-\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]';
const LABEL_SPACE_EDGES = new RegExp(`^${LABEL_SPACE}+|${LABEL_SPACE}+$`, 'gu');

/** `name` without the listed spaces at either end (`LABEL_SPACE`), the same on both platforms. */
function trimLabelName(name: string): string {
  return name.replace(LABEL_SPACE_EDGES, '');
}

/**
 * Compares two strings code point by code point - the order Rust's `str` has, which UTF-16 code
 * units (JavaScript's `<`) do not keep past the Basic Multilingual Plane.
 */
function compareByCodePoint(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0) ?? 0);
  const y = Array.from(b, (c) => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return x.length - y.length;
}

/**
 * The label for a group holding `memberIds`, as `viewerId` sees it: the OTHER members' first names,
 * sorted: up to three spelt out, past that two named and the rest counted. `null` when nobody else
 * is in the group - the caller keeps its own word for that ("Groupe"), because a label naming nobody
 * is not a name.
 */
export function composeUnnamedGroupLabel(
  memberIds: readonly string[],
  viewerId: string,
  firstNameOf: (userId: string) => string
): string | null {
  const viewer = canonicalUserId(viewerId);
  const names = [...new Set(memberIds.map(canonicalUserId))]
    .filter((id) => id !== viewer)
    .map((id) => ({ id, name: trimLabelName(firstNameOf(id)) || id }))
    // ONE fixed collation, not the device's locale - nor the engine's: an English and a French
    // phone, a WebView and a push drawn natively while the app is dead, sort "Émile" the same way
    // only when they are told the same rules, written out (`labelCollationKey`) rather than left to
    // an ICU table that differs between engines.
    .sort(
      (a, b) =>
        compareByCodePoint(labelCollationKey(a.name), labelCollationKey(b.name)) ||
        compareByCodePoint(a.name, b.name) ||
        compareByCodePoint(a.id, b.id)
    )
    .map((entry) => entry.name);

  const [first, second, third] = names;
  switch (names.length) {
    case 0:
      return null;
    case 1:
      return first;
    case 2:
      return m.group_default_name_two({ first, second });
    case UNNAMED_GROUP_SHOWN_NAMES:
      return m.group_default_name_three({ first, second, third });
    default:
      // Past three, TWO are named and the rest counted - never "et 1 autres", which a third name
      // and a count of one would read.
      return m.group_default_name_more({ first, second, count: names.length - 2 });
  }
}
