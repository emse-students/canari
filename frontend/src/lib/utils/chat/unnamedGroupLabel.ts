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
export const UNNAMED_GROUP_SHOWN_NAMES = 3;

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
    .map((id) => ({ id, name: firstNameOf(id).trim() || id }))
    // ONE fixed collation, not the device's locale: an English and a French phone sort "Émile" the
    // same way only when they are told the same rules.
    .sort((a, b) => a.name.localeCompare(b.name, 'fr') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
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
