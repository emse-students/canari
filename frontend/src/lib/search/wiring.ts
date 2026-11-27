/**
 * THE REAL SOURCES OF EACH SECTION, wired once for an open search. Kept apart from `providers.ts` so
 * the providers stay testable with plain functions, and so ONE place names what the search reads.
 *
 * A list the server sends (the association directory, the agenda, the managed forms) is read ONCE per
 * opening of the search and matched on the device at every keystroke after that: the words never go
 * to the server for those sections, and the server is asked once, not once per letter.
 */
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { searchDirectory } from '$lib/profile/api';
import {
  listAggregatedCalendarFeed,
  listAssociationDirectory,
  type AssociationCalendarFeedEvent,
} from '$lib/associations/api';
import { getForms } from '$lib/forms/api';
import { searchPosts } from '$lib/posts/api';
import { settingsSearchIndex } from '$lib/settings/settingsSections';
import { globalChannels, globalConvs, globalSession } from '$lib/stores/globalChatSingleton.svelte';
import { getSavedUserId } from '$lib/stores/user';
import { selfConversationLabels, selfConversationTitle } from '$lib/utils/chat/conversations';
import {
  mergeHeldConversations,
  readStoredConversations,
  type HeldConversation,
} from '$lib/utils/chat/heldConversations';
import { requestConversationOpening } from '$lib/utils/chat/pendingChatOpening';
import { openChannelConversation } from '$lib/utils/chat/notificationRouting';
import { appendLog } from '$lib/utils/sessionLog';
import {
  discardLocalMessageIndex,
  openLocalMessageIndex,
  type LocalMessageIndex,
} from './localMessageIndex';
import {
  associationsProvider,
  communitiesProvider,
  discussionsProvider,
  eventsProvider,
  formsProvider,
  peopleProvider,
  settingsProvider,
} from './providers';
import type { SearchProvider } from './types';
import type { PostsSearch } from './universalSearch.svelte';

/** `load`, asked once: every caller joins the first read, and a failed read is asked again. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
}

/** What an open search is handed: its providers, the posts reader, and how to close it. */
export interface UniversalSearchWiring {
  providers: SearchProvider[];
  posts: PostsSearch;
  /** Drops the decrypted message index and everything read for this opening. */
  close: () => void;
}

/**
 * Wires every section for one opening of the search. `onStoreChanged` is called when the local
 * message index holds something new - it read further, or read a store write (the Discussions
 * section runs again);
 * `onOpenEvent` opens an event's sheet over the search.
 */
export function wireUniversalSearch(opts: {
  onStoreChanged: () => void;
  onOpenEvent: (event: AssociationCalendarFeedEvent) => void;
}): UniversalSearchWiring {
  const uid = globalSession.userId ?? getSavedUserId() ?? '';
  const stored = once(() => (uid ? readStoredConversations(uid) : Promise.resolve([])));

  const conversations = async (): Promise<HeldConversation[]> =>
    mergeHeldConversations({
      stored: await stored(),
      live: globalSession.isLoggedIn ? globalConvs.conversations.entries() : null,
      uid,
      liveAuthoritative: globalSession.isLoggedIn && globalConvs.conversationsRestored,
    });

  let index: LocalMessageIndex | null = null;
  const messageIndex = (): LocalMessageIndex | null => {
    // THE SEARCH BELONGS TO THE ACCOUNT THAT OPENED IT: if another one is signed in now, it reads
    // nothing (and `openLocalMessageIndex` never hands one account's index to another).
    const signedIn = globalSession.userId ?? getSavedUserId() ?? '';
    const storage = globalSession.storage;
    const key = globalSession.deviceKeyB64;
    if (!uid || signedIn !== uid || !storage || !key) return null;
    if (index?.isDiscarded) index = null;
    index ??= openLocalMessageIndex(
      uid,
      {
        conversationIds: async () => (await conversations()).map((c) => c.meta.id),
        readMessages: (id) => storage.getMessages(id, key),
        readMessagesByIds: async (id, ids) => [
          ...(await storage.getMessagesByIds(id, ids, key)).rows.values(),
        ],
      },
      appendLog,
      opts.onStoreChanged
    );
    return index;
  };

  const selfLabels = (): string[] => selfConversationLabels(selfConversationTitle('', uid));

  const providers: SearchProvider[] = [
    peopleProvider({ searchDirectory }),
    discussionsProvider({
      conversations,
      index: messageIndex,
      selfLabels,
      open: (conversationId) => {
        requestConversationOpening(conversationId, sessionStorage);
        void goto(resolve('/chat'));
      },
    }),
    communitiesProvider({
      workspaces: () => globalChannels.channelWorkspaces,
      open: (channelConversationId) => {
        if (channelConversationId) void openChannelConversation(channelConversationId);
        else void goto(resolve('/communities'));
      },
    }),
    associationsProvider({ directory: once(() => listAssociationDirectory()) }),
    eventsProvider({
      agenda: (() => {
        let read: (() => Promise<AssociationCalendarFeedEvent[]>) | null = null;
        return (window: { from: string; to: string }) => {
          read ??= once(() => listAggregatedCalendarFeed(window));
          return read();
        };
      })(),
      now: () => new Date(),
      open: opts.onOpenEvent,
    }),
    formsProvider({ forms: once(() => getForms()) }),
    settingsProvider({ index: settingsSearchIndex }),
  ];

  // Warm the message index as the search opens, so it is read by the time the words are typed.
  void messageIndex()
    ?.refresh()
    .catch((e: unknown) => console.error(`[SEARCH] the local index did not open: ${String(e)}`));

  return {
    providers,
    posts: (criteria, page) => searchPosts(criteria, page),
    close: () => {
      discardLocalMessageIndex('search closed');
      index = null;
    },
  };
}
