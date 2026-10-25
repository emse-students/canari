// @vitest-environment happy-dom
/**
 * THE ACTING DEVICE'S OWN NOTICE SURVIVES ITS OWN HANDLER.
 *
 * `sendVisibleNotice` writes the rename / photo notice into the conversation DURING the handler's
 * await. The handlers then wrote back the conversation snapshot they had taken BEFORE that await -
 * `{ ...convo, name }` - and the notice vanished from the one screen that had never drawn it. Run
 * through the real handlers, with an `addMessageToChat` that writes into the real map.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { AddMessageToChatOptions, Conversation } from '$lib/types';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));
// Names are a profile read nothing here is about: every id draws as itself.
vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  resolveDisplayNames: async () => (id: string) => id,
}));

const { useConversations } = await import('./useConversations.svelte');

const GROUP_ID = 'e4c1f0aa-0000-4000-8000-00000000000a';

function setup() {
  const convs = useConversations();
  convs.conversations.set(GROUP_ID, {
    id: GROUP_ID,
    name: 'Avant',
    messages: [],
    lifecycle: 'active',
    conversationType: 'group',
  } as unknown as Conversation);
  convs.selectConversation(GROUP_ID);
  const mls = createMlsServiceStub();
  // What `addMessageToChat` does to the map, reduced to the write this test is about.
  const addMessageToChat = vi.fn(
    async (senderId: string, content: string, key: string, options?: AddMessageToChatOptions) => {
      const current = convs.conversations.get(key)!;
      convs.conversations.set(key, {
        ...current,
        messages: [
          ...current.messages,
          {
            id: options!.messageId!,
            senderId,
            content,
            timestamp: new Date(),
            isOwn: false,
            isSystem: true,
          },
        ],
      });
    }
  );
  const ctx = {
    storage: null,
    ensureMls: () => mls,
    userId: 'alice',
    deviceKeyB64: 'k',
    historyBaseUrl: '',
    messageReactions: new SvelteMap(),
    log: vi.fn(),
    addMessageToChat,
  } as never;
  return { convs, ctx, addMessageToChat };
}

describe('the acting device keeps the notice its own send wrote', () => {
  it('after a rename: the new name AND the notice', async () => {
    const { convs, ctx, addMessageToChat } = setup();
    await convs.handleRenameGroup('Apres', ctx);

    expect(addMessageToChat).toHaveBeenCalledTimes(1);
    const convo = convs.conversations.get(GROUP_ID)!;
    expect(convo.name).toBe('Apres');
    expect(convo.messages.map((m) => m.id)).toEqual([addMessageToChat.mock.calls[0][3]!.messageId]);
  });

  it('after a photo change: the new photo AND the notice', async () => {
    const { convs, ctx, addMessageToChat } = setup();
    await convs.handleSetGroupImage('media-1', ctx);

    expect(addMessageToChat).toHaveBeenCalledTimes(1);
    const convo = convs.conversations.get(GROUP_ID)!;
    expect(convo.imageMediaId).toBe('media-1');
    expect(convo.messages.map((m) => m.id)).toEqual([addMessageToChat.mock.calls[0][3]!.messageId]);
  });
});
