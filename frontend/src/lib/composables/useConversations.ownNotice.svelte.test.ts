// @vitest-environment happy-dom
/**
 * THE ACTING DEVICE'S OWN NOTICE SURVIVES ITS OWN HANDLER.
 *
 * `sendVisibleNotice` writes the rename / photo notice into the conversation DURING the handler's
 * await. The handlers then wrote back the conversation snapshot they had taken BEFORE that await -
 * `{ ...convo, name }` - and the notice vanished from the one screen that had never drawn it. Run
 * through the real handlers, with an `addMessageToChat` that writes into the real map.
 */
import type { AddMessageToChatOptions, Conversation } from '$lib/types';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { ReactionsByConversation } from '$lib/utils/chat/reactionsByConversation';

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

const toasts: Array<{ message: string; type: string }> = [];
vi.mock('$lib/stores/toast.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/toast.svelte')>()),
  showToast: (message: string, type = 'error') => {
    toasts.push({ message, type });
  },
}));

const { useConversations } = await import('./useConversations.svelte');
const { DeliveryUnreachableError } = await import('$lib/mls-client/mlsDeliveryApi');
const { FrameNotHandedError } = await import('$lib/mls-client/frameFromAnyTab');

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
  // The server accepts each send 40 ms after this clock: a rename bounds its own frame's server time
  // by the sentAt it signed (`renameGroupAndBroadcast`), so a fixed 2023 answer would refuse it.
  vi.mocked(mls.sendMessage).mockImplementation(
    async () => ({ sealed: new Uint8Array(), receivedAt: Date.now() + 40 }) as never
  );
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
    messageReactions: new ReactionsByConversation(),
    log: vi.fn(),
    addMessageToChat,
  } as never;
  return { convs, ctx, addMessageToChat, mls };
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

  it('a rename whose server copy failed keeps the name, dated, and records the copy as owed', async () => {
    const { convs, ctx, mls } = setup();
    vi.mocked(mls.renameGroup).mockRejectedValue(new Error('503'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await convs.handleRenameGroup('Apres', ctx);
    const convo = convs.conversations.get(GROUP_ID)!;
    expect(convo.name).toBe('Apres');
    expect(convo.nameAt).toEqual(expect.any(Number));
    expect(convo.nameSync).toEqual({ serverCopy: { name: 'Apres', from: 'Avant' } });
  });

  // P2-b: A LOST ANSWER IS NOT A REFUSAL. The server may hold the frame and every member the name;
  // telling the user "failed" split the group. The frame is kept pending, under its own id.
  it('a send with no answer is pending, never failed: the name shown stays, the frame is kept', async () => {
    const { convs, ctx, mls, addMessageToChat } = setup();
    vi.mocked(mls.sendMessage).mockRejectedValue(new DeliveryUnreachableError('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await convs.handleRenameGroup('Apres', ctx);
    const convo = convs.conversations.get(GROUP_ID)!;
    expect(convo.name).toBe('Avant');
    expect(convo.nameSync?.pending).toMatchObject({ name: 'Apres', over: { name: 'Avant' } });
    expect(convo.nameSync?.pending?.messageId).toEqual(expect.any(String));
    expect(mls.renameGroup).not.toHaveBeenCalled();
    expect(addMessageToChat).not.toHaveBeenCalled();
    expect(toasts.at(-1)).toMatchObject({ type: 'info' });
    expect(error).not.toHaveBeenCalled();
  });

  it("a FOLLOWER tab's rename whose leader died holding it is pending too, never failed", async () => {
    const { convs, ctx, mls } = setup();
    vi.mocked(mls.sendMessage).mockRejectedValue(new FrameNotHandedError(GROUP_ID, 'leader-gone'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await convs.handleRenameGroup('Apres', ctx);
    const convo = convs.conversations.get(GROUP_ID)!;
    expect(convo.name).toBe('Avant');
    expect(convo.nameSync?.pending).toMatchObject({ name: 'Apres' });
    expect(toasts.at(-1)).toMatchObject({ type: 'info' });
  });

  it('a send the server ANSWERED with a refusal is a failed rename: nothing pending', async () => {
    const { convs, ctx, mls } = setup();
    vi.mocked(mls.sendMessage).mockRejectedValue(new Error('403'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await convs.handleRenameGroup('Apres', ctx);
    const convo = convs.conversations.get(GROUP_ID)!;
    expect(convo.name).toBe('Avant');
    expect(convo.nameSync).toBeUndefined();
    expect(toasts.at(-1)).toMatchObject({ type: 'error' });
  });

  it('a clock off by more than a day: no name taken, no server copy written', async () => {
    const { convs, ctx, mls } = setup();
    vi.mocked(mls.sendMessage).mockImplementation(
      async () =>
        ({ sealed: new Uint8Array(), receivedAt: Date.now() + 2 * 24 * 60 * 60 * 1000 }) as never
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await convs.handleRenameGroup('Apres', ctx);
    expect(convs.conversations.get(GROUP_ID)!.name).toBe('Avant');
    expect(mls.renameGroup).not.toHaveBeenCalled();
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
