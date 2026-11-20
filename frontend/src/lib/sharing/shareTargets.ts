/**
 * Which conversations the phone's share sheet suggests (sharing lot S5), and when they are told.
 *
 * THE DESTINATIONS ARE THE PICKER'S. The suggestions are the "Envoyer a..." picker's own candidates
 * (DMs, groups, salons, named by `shareDestinationPresentation`), restricted to the ones that can
 * receive a message (`lifecycle === 'active'`) and whose name is known, ordered by the sidebar's
 * ONE recency key (`compareConversationRecency`) - no second notion of "recent" is derived here.
 *
 * WHEN. The list is read by ONE kind of reader, and it lives outside the app: the system share
 * sheet and the launcher. So it is computed and sent when the member LEAVES the app
 * (`followShareTargets`, on `onAppScreenChange`), never on a change of the conversation map: a
 * first sync rebuilds that map for many seconds from provisional inputs (a joined row seeded with
 * its admission time until its history lands, a DM name resolved outside the reactive graph, a
 * salon's community loading late), and following it republished every intermediate state - 23
 * publishes in one sync, measured. Sent only when the ordered ids and names differ from what the
 * native side was last told (`shareTargetsNative.ts`). No debounce, no clock. Setting off ->
 * cleared at once, on -> published at once (the member's own act). Sign-out -> cleared by
 * `stores/auth` (`eraseAccountShortcuts`). Both phone apps, through the same two commands: Android
 * sharing shortcuts, iOS `INSendMessageIntent` donations. See `docs/wiki/frontend/sharing.md`.
 */
import { compareConversationRecency } from '$lib/utils/chat/conversations';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import { MOBILE_APP_PROTOCOL } from '$lib/mobile/appSiteAssociation';
import { isMobileTauriRuntime } from '$lib/utils/appVersion';
import type { Conversation } from '$lib/types';
import {
  channelCommunities,
  channelCommunityLogos,
  shareDestinationPresentation,
  type WorkspaceLike,
} from './shareDestinations';
import {
  clearShareTargets,
  publishShareTargets,
  shareTargetId,
  type ShareTarget,
  type ShareTargetAvatar,
} from './shareTargetsNative';

/**
 * How many conversations are suggested. The sheet's direct row shows four to eight, and the
 * platform's per-activity cap (`getMaxShortcutCountPerActivity`, often 15) is shared with the
 * conversation shortcuts message notifications publish - so few, and the native side still caps.
 */
export const MAX_SHARE_TARGETS = 5;

/** The native side drops a longer label; a name is cut rather than the suggestion lost. */
const MAX_LABEL_LENGTH = 100;

/** The deep link a suggestion opens when tapped from the launcher - the notification's own. */
function chatLink(conversationId: string): string {
  return `${MOBILE_APP_PROTOCOL}//chat/${conversationId}`;
}

/**
 * The picture the app itself draws for this destination (`ConversationPickList`): the peer's photo
 * for a DM, the group's image, the community's logo for a salon. Absent when none is known - the
 * native side then draws the initials of the label, as the app does.
 */
function shareTargetAvatar(
  c: Conversation,
  contactId: string,
  isDirect: boolean,
  logoOf: Map<string, string>
): ShareTargetAvatar | undefined {
  if (isDirect) return contactId ? { kind: 'user', id: contactId } : undefined;
  if (isChannelConversationId(c.id)) {
    const logo = logoOf.get(c.id);
    return logo ? { kind: 'media', id: logo } : undefined;
  }
  return c.imageMediaId ? { kind: 'media', id: c.imageMediaId } : undefined;
}

/**
 * The `limit` most recent destinations of the share picker, most recent first, as suggestions.
 * A salon's name carries its community, since several salons share a name.
 */
export function selectShareTargets(
  conversations: Iterable<[string, Conversation]>,
  currentUserId: string,
  workspaces: readonly WorkspaceLike[],
  limit = MAX_SHARE_TARGETS
): ShareTarget[] {
  const communityOf = channelCommunities(workspaces);
  const logoOf = channelCommunityLogos(workspaces);
  const targets: ShareTarget[] = [];
  const ordered = [...conversations]
    .map(([, c]) => c)
    .filter((c) => c.lifecycle === 'active')
    .sort(compareConversationRecency);
  for (const c of ordered) {
    if (targets.length >= limit) break;
    const id = shareTargetId(c.id);
    if (!id) continue;
    const pres = shareDestinationPresentation(c, currentUserId);
    if (!pres.displayNameResolved || !pres.displayName.trim()) continue;
    const community = isChannelConversationId(c.id) ? communityOf.get(c.id) : undefined;
    const name = community ? `${pres.displayName} (${community})` : pres.displayName;
    const avatar = shareTargetAvatar(c, pres.contactId, pres.conversationType === 'direct', logoOf);
    targets.push({
      id,
      label: name.trim().slice(0, MAX_LABEL_LENGTH),
      link: chatLink(c.id),
      ...(avatar ? { avatar } : {}),
    });
  }
  return targets;
}

/** What the suggestions depend on, read by `IncomingShareHost` from the live stores. */
export interface ShareTargetsInput {
  /** The member's setting (`settings.shareSuggestionsEnabled`). */
  enabled: boolean;
  signedIn: boolean;
  /**
   * Every source that can add a conversation to THIS session's list has finished
   * (`conversationSourcesSettled`, whose restore half is reset at sign-out) - so the next account
   * never publishes from a list still loading.
   */
  conversationsReady: boolean;
  /**
   * Read only when a publish is due - at the moment the member leaves the app or turns the
   * suggestions on, never by an effect following the map.
   */
  conversations: () => Iterable<[string, Conversation]>;
  currentUserId: string;
  workspaces: () => readonly WorkspaceLike[];
}

/**
 * Brings the share sheet's suggestions in line with `input` NOW: cleared when the member turned them
 * off, the current top conversations once signed in and the list is read, nothing otherwise (a
 * locked or loading session neither publishes a partial list nor erases a good one - the sign-out
 * is what erases). Phone apps only. Resolves when the native side has answered (the queued call
 * settled), so a caller that must keep the process alive - a departure on iOS - can await it.
 */
export function syncShareTargets(input: ShareTargetsInput, reason: string): Promise<void> {
  if (!isMobileTauriRuntime()) return Promise.resolve();
  if (!input.enabled) return clearShareTargets('suggestions turned off');
  if (!input.signedIn || !input.conversationsReady) return Promise.resolve();
  return publishShareTargets(
    selectShareTargets(input.conversations(), input.currentUserId, input.workspaces()),
    reason
  );
}
