// @vitest-environment happy-dom
/**
 * The "Nouvelle discussion" panel creates a group, then invites the people chosen. Once the creation
 * succeeded the group EXISTS, so an invitation that throws must not surface as a refusal nor as an
 * unhandled rejection: the panel would stay open over an existing group and a retry would create a
 * second one (review of #3793). The answer stays ok, with the key, and the cause is logged.
 */
import type { Conversation } from '$lib/types';
import { ReactionsByConversation } from '$lib/utils/chat/reactionsByConversation';

const createGroup = vi.hoisted(() => vi.fn());
const inviteMembersToGroup = vi.hoisted(() => vi.fn());

vi.mock('$lib/utils/chat/groupCreation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/groupCreation')>();
  return { ...actual, createNewGroup: createGroup, inviteMembersToGroup };
});

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

const { useConversations } = await import('./useConversations.svelte');

const KEY = 'g-new';

function makeCtx() {
  const log = vi.fn();
  return {
    log,
    ctx: {
      storage: null,
      ensureMls: () => ({ getLocalGroups: () => [KEY] }),
      userId: 'u1',
      deviceKeyB64: 'k',
      messageReactions: new ReactionsByConversation(),
      log,
      addMessageToChat: vi.fn(),
    } as never,
  };
}

it('answers ok with the key, logs, and creates nothing twice when the invitation throws', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const store = useConversations();
  createGroup.mockImplementation(async () => {
    store.conversations.set(KEY, {
      id: KEY,
      name: '',
      messages: [],
      lifecycle: 'active',
      conversationType: 'group',
    } as unknown as Conversation);
    return { ok: true, key: KEY };
  });
  inviteMembersToGroup.mockRejectedValue(new Error('welcome publish failed'));
  const { ctx, log } = makeCtx();

  const outcome = await store.createGroupWithMembers('', ['alice', 'bob'], ctx);

  expect(outcome).toEqual({ ok: true, key: KEY });
  expect(createGroup).toHaveBeenCalledTimes(1);
  expect(inviteMembersToGroup).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.stringContaining('invitation into the new group threw'));
  error.mockRestore();
});
