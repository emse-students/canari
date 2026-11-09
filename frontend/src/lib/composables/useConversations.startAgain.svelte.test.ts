// @vitest-environment happy-dom
/**
 * "Recommencer avec les mêmes personnes" on a conversation this device can no longer open (D5 of
 * docs/wiki/protocols/mls-availability-no-holder.md, review of #2832): ONE group per decision, and a
 * failure the user is told about rather than a button that silently did nothing.
 */
import type { Conversation } from '$lib/types';

const fetchGroupRoster = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/chat/groupActions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/groupActions')>();
  return { ...actual, fetchGroupRoster };
});

const createGroup = vi.hoisted(() => vi.fn());
const inviteMembersToGroup = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/chat/groupCreation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/groupCreation')>();
  return { ...actual, createNewGroup: createGroup, inviteMembersToGroup };
});

const showToast = vi.hoisted(() => vi.fn());
vi.mock('$lib/stores/toast.svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/stores/toast.svelte')>();
  return { ...actual, showToast };
});

// Same isolation reasoning as the other composable tests: the global chat singleton instantiates
// `useConversations` at module scope, so importing it directly closes a cycle.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

const { useConversations } = await import('./useConversations.svelte');

const CONTACT = 'Les Canaris';
const GROUP_ID = 'e4c1f0aa-0000-4000-8000-00000000000a';

function unopenable(): Conversation {
  return {
    id: GROUP_ID,
    name: CONTACT,
    messages: [],
    lifecycle: 'pending',
    conversationType: 'group',
  } as unknown as Conversation;
}

function makeCtx() {
  const log = vi.fn();
  return {
    log,
    ctx: {
      storage: null,
      ensureMls: () => ({}),
      userId: 'u1',
      deviceKeyB64: 'k',
      log,
      addMessageToChat: vi.fn(),
    } as never,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchGroupRoster.mockResolvedValue(['u1', 'u2']);
});

describe('handleStartAgainWithSamePeople', () => {
  it('ignores a second tap while the first is creating, so one group is made', async () => {
    let release: (v: unknown) => void = () => {};
    createGroup.mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        })
    );
    const convs = useConversations();
    convs.conversations.set(CONTACT, unopenable());
    convs.selectConversation(CONTACT);
    const { ctx, log } = makeCtx();

    const first = convs.handleStartAgainWithSamePeople(ctx);
    await vi.waitFor(() => expect(createGroup).toHaveBeenCalledTimes(1));
    await convs.handleStartAgainWithSamePeople(ctx);
    release({ ok: false, reason: 'test' });
    await first;

    expect(createGroup).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already under way'));
  });

  it('tells the user when the roster cannot be read, and lets the next tap try again', async () => {
    fetchGroupRoster.mockRejectedValueOnce(new Error('offline'));
    createGroup.mockResolvedValue({ ok: false, reason: 'test' });
    const convs = useConversations();
    convs.conversations.set(CONTACT, unopenable());
    convs.selectConversation(CONTACT);
    const { ctx } = makeCtx();

    await convs.handleStartAgainWithSamePeople(ctx);
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error');
    expect(createGroup).not.toHaveBeenCalled();

    await convs.handleStartAgainWithSamePeople(ctx);
    expect(createGroup).toHaveBeenCalledTimes(1);
  });

  it('tells the user when the new group was not created', async () => {
    createGroup.mockResolvedValue({ ok: false, reason: 'refused' });
    const convs = useConversations();
    convs.conversations.set(CONTACT, unopenable());
    convs.selectConversation(CONTACT);

    await convs.handleStartAgainWithSamePeople(makeCtx().ctx);

    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });
});
