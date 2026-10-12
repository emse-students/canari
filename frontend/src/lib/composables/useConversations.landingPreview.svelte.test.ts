/**
 * F1 - THE NOTIFICATION LANDING'S LOCAL PREVIEW (user decision 2026-10-12).
 *
 * A tapped notification's conversation is drawn from the local store while the session is still
 * being verified, and that is allowed on four conditions this file pins:
 *  - the preview READS and never acts: no request, no write, no read mark, no member load;
 *  - selecting it before the session pushes the Back entry and nothing else;
 *  - a login that does not finish removes everything it drew;
 *  - the restore that follows does not blank the thread on screen.
 */
export {};

const pushed: Array<() => void> = [];
const { pushHistoryOverlay, publishConversationRead } = vi.hoisted(() => ({
  pushHistoryOverlay: vi.fn(),
  publishConversationRead: vi.fn(),
}));

vi.mock('$lib/utils/historyOverlayStack', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/historyOverlayStack')>();
  return {
    ...actual,
    isMobileOverlayLayout: () => true,
    pushHistoryOverlay,
    abandonHistoryOverlay: vi.fn(),
  };
});
vi.mock('$lib/mls-client/tabMessageSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/mls-client/tabMessageSync')>();
  return { ...actual, publishConversationRead };
});
// Same isolation reasoning as the sibling composable tests (a module-scope instantiation cycle).
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

const { SvelteMap } = await import('svelte/reactivity');
const { useConversations } = await import('./useConversations.svelte');
const { notifNav } = await import('$lib/stores/notifNav.svelte');
const { readLandingPreview } = await import('$lib/utils/chat/landingPreview');

const GROUP_ID = 'e4c1f0aa-0000-4000-8000-0000000000f1';
const USER = 'me@example.test';

/** A store holding one conversation and two messages, which records every call made on it. */
function fakeStorage() {
  const calls: string[] = [];
  const storage = {
    getConversation: vi.fn(async (id: string) => {
      calls.push(`getConversation:${id}`);
      return id === GROUP_ID
        ? { id: GROUP_ID, name: 'Bench', lifecycle: 'active', updatedAt: 2_000 }
        : null;
    }),
    getMessagesPage: vi.fn(async (id: string) => {
      calls.push(`getMessagesPage:${id}`);
      return [
        { id: 'm1', conversationId: id, senderId: 'peer', content: 'hello', timestamp: 1_000 },
        { id: 'm2', conversationId: id, senderId: USER, content: 'hi', timestamp: 2_000 },
      ];
    }),
  };
  return { storage: storage as never, calls };
}

function previewInput(storage: never, sessionUp = false) {
  return {
    storage,
    deviceKeyB64: 'a2V5',
    userId: USER,
    messageReactions: new SvelteMap() as never,
    isSessionUp: () => sessionUp,
    log: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pushed.length = 0;
  pushHistoryOverlay.mockImplementation((close: () => void) => pushed.push(close));
  notifNav.clear();
});

describe('readLandingPreview', () => {
  it('reads the row and its newest page from the store, and makes no request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { storage, calls } = fakeStorage();
    const preview = await readLandingPreview({
      storage,
      deviceKeyB64: 'a2V5',
      userId: USER,
      targetId: GROUP_ID,
    });
    expect(typeof preview).toBe('object');
    if (typeof preview === 'string') return;
    expect(preview.row.id).toBe(GROUP_ID);
    expect(preview.row.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    // Reads only: no save of any kind is reachable from the fake, and nothing went to the network.
    expect(calls).toEqual([`getConversation:${GROUP_ID}`, `getMessagesPage:${GROUP_ID}`]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('has nothing to draw for a community salon, whose history is never stored', async () => {
    const { storage, calls } = fakeStorage();
    const out = await readLandingPreview({
      storage,
      deviceKeyB64: 'a2V5',
      userId: USER,
      targetId: 'channel_x',
    });
    expect(out).toBe('channel');
    expect(calls).toEqual([]);
  });
});

describe('the landing preview in the conversation store', () => {
  it('draws the target before the session and marks it as a preview', async () => {
    const convs = useConversations();
    const { storage } = fakeStorage();
    notifNav.navigate(GROUP_ID);
    await convs.previewLandingTarget(previewInput(storage));
    expect(convs.conversations.get(GROUP_ID)?.messages).toHaveLength(2);
    expect(convs.landingPreviewKey).toBe(GROUP_ID);
  });

  it('is not a preview when the session came up during the read - the row is the session one', async () => {
    const convs = useConversations();
    const { storage } = fakeStorage();
    notifNav.navigate(GROUP_ID);
    await convs.previewLandingTarget(previewInput(storage, true));
    expect(convs.conversations.has(GROUP_ID)).toBe(true);
    expect(convs.landingPreviewKey).toBeNull();
  });

  it('never replaces a row the map already holds', async () => {
    const convs = useConversations();
    const { storage, calls } = fakeStorage();
    convs.conversations.set(GROUP_ID, { id: GROUP_ID, name: 'Live', messages: [] } as never);
    notifNav.navigate(GROUP_ID);
    await convs.previewLandingTarget(previewInput(storage));
    expect(convs.conversations.get(GROUP_ID)?.name).toBe('Live');
    expect(calls).toEqual([]);
    expect(convs.landingPreviewKey).toBeNull();
  });

  it('selects the preview with the Back entry and WITHOUT a read mark', async () => {
    const convs = useConversations();
    const { storage } = fakeStorage();
    notifNav.navigate(GROUP_ID);
    await convs.previewLandingTarget(previewInput(storage));
    convs.previewSelect(GROUP_ID);
    expect(convs.selectedContact).toBe(GROUP_ID);
    expect(pushed).toHaveLength(1);
    expect(publishConversationRead).not.toHaveBeenCalled();
  });

  it('refuses to select anything that is not the preview', () => {
    const convs = useConversations();
    convs.conversations.set('other', { id: 'other', name: 'other', messages: [] } as never);
    convs.previewSelect('other');
    expect(convs.selectedContact).toBeNull();
  });

  it('removes everything it drew when the login does not finish', async () => {
    const convs = useConversations();
    const { storage } = fakeStorage();
    const reactions = new SvelteMap<string, never>();
    notifNav.navigate(GROUP_ID);
    await convs.previewLandingTarget(previewInput(storage));
    convs.previewSelect(GROUP_ID);
    convs.discardLandingPreview('device revoked', reactions as never, vi.fn());
    expect(convs.conversations.has(GROUP_ID)).toBe(false);
    expect(convs.selectedContact).toBeNull();
    expect(convs.landingPreviewKey).toBeNull();
  });

  it('keeps the row once the session owns it', async () => {
    const convs = useConversations();
    const { storage } = fakeStorage();
    notifNav.navigate(GROUP_ID);
    await convs.previewLandingTarget(previewInput(storage));
    convs.endLandingPreview();
    convs.discardLandingPreview('late', new SvelteMap() as never, vi.fn());
    expect(convs.conversations.has(GROUP_ID)).toBe(true);
  });
});
