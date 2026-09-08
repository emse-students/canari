/**
 * A deep-link landing may only give up on a target once EVERY source that can create it has run.
 *
 * `conversationsRestored` says one thing - the IndexedDB pass has populated the map - and a landing
 * read it as another: that the set of this device's conversations is complete. The two differ by
 * exactly the FCM cache, which runs AFTER the restore and is the only route by which a first
 * message from a new correspondent becomes a conversation at all. So a tap on a first-contact
 * notification saw a "settled" map without its target, concluded the conversation was not on this
 * device, and abandoned - milliseconds before the placeholder that would have satisfied it was
 * written. The app opened on nothing, which is what was reported from production on 2026-09-08.
 *
 * THE ASSERTION IS INSIDE THE WINDOW. Checking the end state passes on the broken code too: the
 * conversation does arrive in the end, and `conversationsRestored` is true either way. What
 * distinguishes the fix is the answer given DURING the span, which is where the landing ran.
 */
import { SvelteMap } from 'svelte/reactivity';

const loadExistingConversations = vi.hoisted(() => vi.fn());

vi.mock('$lib/utils/chat/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/conversations')>();
  return { ...actual, loadExistingConversations };
});

// Same isolation reasoning as the other composable tests: `useConversations` is reachable from the
// global chat singleton's own module-scope instantiation, so importing it directly closes a cycle.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

const { useConversations } = await import('./useConversations.svelte');

function makeCtx() {
  const mls = {
    getLocalGroups: () => [],
    getDeviceId: () => 'dev-1',
    notifyConversationsRestored: vi.fn(),
  };
  return {
    storage: { saveConversation: vi.fn(async () => undefined) },
    ensureMls: () => mls,
    userId: 'u1',
    deviceKeyB64: 'k',
    messageReactions: new SvelteMap(),
    log: vi.fn(),
    addMessageToChat: vi.fn(),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  loadExistingConversations.mockResolvedValue(undefined);
});

describe('conversationSourcesSettled - the landing waits for every source, not just the restore', () => {
  it('is unsettled before anything has run', () => {
    const convs = useConversations();
    expect(convs.conversationsRestored).toBe(false);
    expect(convs.conversationSourcesSettled).toBe(false);
  });

  it('stays unsettled through the restore while a later source is still open', async () => {
    const convs = useConversations();
    // The login sequence opens the span BEFORE the restore, because the restore and the FCM cache
    // are separated by awaits and any gap between them is the defect in miniature.
    convs.beginConversationSource();
    await convs.loadAndRestoreConversations(makeCtx());

    // The restore really has finished - this is not a test of a slow restore.
    expect(convs.conversationsRestored).toBe(true);
    // ...and the landing must STILL not conclude the target is missing: the FCM cache, which is
    // what would create it, has not run yet. This assertion is the whole fix.
    expect(convs.conversationSourcesSettled).toBe(false);

    convs.endConversationSource();
    expect(convs.conversationSourcesSettled).toBe(true);
  });

  it('does not settle on an unbalanced close, and never counts below zero', async () => {
    const convs = useConversations();
    // Resume can overlap login: two spans open, and the first to close must not unlock the landing
    // for the second. A floor at zero keeps a stray close from wedging it shut the other way.
    convs.endConversationSource();
    convs.beginConversationSource();
    convs.beginConversationSource();
    await convs.loadAndRestoreConversations(makeCtx());
    convs.endConversationSource();
    expect(convs.conversationSourcesSettled).toBe(false);
    convs.endConversationSource();
    expect(convs.conversationSourcesSettled).toBe(true);
  });

  it('settles after a restore that threw, so a failure cannot strand every deep link', async () => {
    const convs = useConversations();
    loadExistingConversations.mockRejectedValue(new Error('IndexedDB unavailable'));
    convs.beginConversationSource();
    await expect(convs.loadAndRestoreConversations(makeCtx())).rejects.toThrow();
    // The login sequence closes its span in a `finally` for exactly this case.
    convs.endConversationSource();
    expect(convs.conversationSourcesSettled).toBe(true);
  });
});
