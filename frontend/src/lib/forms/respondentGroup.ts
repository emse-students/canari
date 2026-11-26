import { getUserDisplayNameSync, seedUserDisplayName } from '$lib/utils/users/displayName';
import type { FormRespondents } from './api';

/**
 * A GROUP MADE FROM A FORM'S RESPONDENTS (owner, 2026-11-19; forms.md "A group made from a form's
 * respondents"). The button only FILLS the new-discussion panel's member picker: the panel's own
 * rules - the invitation, the admission, the outcome it tells - are the rules of a manual add.
 */

/** A group needs two other people; one respondent is a direct conversation, not a group. */
export const MIN_GROUP_RESPONDENTS = 2;

/**
 * Whether the screen draws the button. The SERVER refuses the same two cases (`FORM_RESPONDENTS_*`),
 * so this only spares a refusal: an anonymous form's group would reveal who answered (charter,
 * principle 1), and a public form's guest has no account to add.
 */
export function respondentGroupOffered(form: { anonymous?: boolean; isPublic?: boolean }): boolean {
  return form.anonymous !== true && form.isPublic !== true;
}

/** One person to preselect in the member picker. */
export interface GroupDraftMember {
  id: string;
  name: string;
}

/**
 * The people the picker is filled with, and how many respondents were left out because their
 * account is gone. The signed-in account is never one of its own members. Each name is seeded, so
 * the chips and the unnamed group's suggestion read at once.
 */
export function groupDraftFrom(
  respondents: FormRespondents,
  selfId: string
): { members: GroupDraftMember[]; departed: number } {
  const self = selfId.trim().toLowerCase();
  const members = respondents.respondents
    .filter((r) => r.id.trim().toLowerCase() !== self)
    .map((r) => {
      const name = [r.firstName, r.lastName].filter(Boolean).join(' ');
      if (name) seedUserDisplayName(r.id, name, r.firstName);
      return { id: r.id, name: name || getUserDisplayNameSync(r.id) };
    });
  return { members, departed: respondents.departed };
}
