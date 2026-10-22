/**
 * Which conversations Android's share sheet suggests (sharing lot S5), and when they are told.
 *
 * THE DESTINATIONS ARE THE PICKER'S. The suggestions are the "Envoyer a..." picker's own candidates
 * (DMs, groups, salons, named by `shareDestinationPresentation`), restricted to the ones that can
 * receive a message (`lifecycle === 'active'`) and whose name is known, ordered by the sidebar's
 * ONE recency key (`compareConversationRecency`) - no second notion of "recent" is derived here.
 *
 * WHEN. `syncShareTargets` is called by `IncomingShareHost` whenever what it reads changes; the
 * list is sent only when the ordered ids and names differ from what the native side was last told
 * (`shareTargetsNative.ts`), so a new message reordering the top of the list republishes and one
 * that does not, sends nothing. No debounce, no clock. Setting off -> cleared. Sign-out -> cleared
 * by `stores/auth` (`clearShareTargets`). Android only: iOS suggestions need the Share Extension
 * (lot S4). See `docs/wiki/frontend/sharing.md`.
 */
import { compareConversationRecency } from '$lib/utils/chat/conversations';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import { MOBILE_APP_PROTOCOL } from '$lib/mobile/appSiteAssociation';
import { isAndroidTauriRuntime } from '$lib/utils/appVersion';
import type { Conversation } from '$lib/types';
import {
  channelCommunities,
  shareDestinationPresentation,
  type WorkspaceLike,
} from './shareDestinations';
import {
  clearShareTargets,
  publishShareTargets,
  shareTargetId,
  type ShareTarget,
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
    targets.push({ id, label: name.trim().slice(0, MAX_LABEL_LENGTH), link: chatLink(c.id) });
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
   * Read only when a publish is due: called inside an effect, a disabled or signed-out state then
   * does not subscribe to every change of the conversation map.
   */
  conversations: () => Iterable<[string, Conversation]>;
  currentUserId: string;
  workspaces: () => readonly WorkspaceLike[];
}

/**
 * Brings the share sheet's suggestions in line with `input`: cleared when the member turned them
 * off, the current top conversations once signed in and the list is read, nothing otherwise (a
 * locked or loading session neither publishes a partial list nor erases a good one - the sign-out
 * is what erases). Android only.
 */
export function syncShareTargets(input: ShareTargetsInput): void {
  if (!isAndroidTauriRuntime()) return;
  if (!input.enabled) {
    void clearShareTargets('suggestions turned off');
    return;
  }
  if (!input.signedIn || !input.conversationsReady) return;
  void publishShareTargets(
    selectShareTargets(input.conversations(), input.currentUserId, input.workspaces()),
    'conversations changed'
  );
}
