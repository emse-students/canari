/**
 * groupDraft - the people a page chose for a NEW GROUP, on their way to the new-discussion panel.
 *
 * The responses screen of a form fills the panel's member picker with the form's respondents
 * (`forms/respondentGroup.ts`); the panel lives on the chat page, so the choice crosses one
 * navigation. It is a DRAFT: the panel opens with these people chosen and the member still names
 * the group and presses create. Memory only, and named by the account that made it - a draft left
 * behind is dropped for anybody else, with a warning, never applied.
 */
import type { GroupDraftMember } from '$lib/forms/respondentGroup';

let pending = $state<{ owner: string; members: GroupDraftMember[] } | null>(null);

export const groupDraft = {
  /** The draft waiting for the chat page; reactive, so the page that mounts later still sees it. */
  get pending(): { owner: string; members: GroupDraftMember[] } | null {
    return pending;
  },

  /** Leaves `members` for the chat page, replacing any draft already waiting. */
  offer(owner: string, members: GroupDraftMember[]): void {
    pending = { owner, members };
  },

  /** Reads AND removes the draft when `owner` made it; another account's is dropped, said. */
  takeFor(owner: string): GroupDraftMember[] | null {
    const draft = pending;
    if (!draft) return null;
    pending = null;
    if (draft.owner !== owner) {
      console.warn('[GROUP] a group draft made by another account was pending - dropped');
      return null;
    }
    return draft.members;
  },
};
