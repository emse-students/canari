/**
 * Backing out of a conversation ENDS the landing that opened it - whichever way you back out.
 *
 * There are two, and only one of them said so. The in-app back control goes through
 * `goBackToMenu`, whose own comment gives the reason: "Backing out of the thread ends any landing,
 * or the target would be re-selected instantly." The HARDWARE Back press does not go through it at
 * all - it pops the history overlay, and the overlay's close callback is what runs. That callback
 * deselected the conversation and left the landing pending, so the landing effect put the target
 * straight back.
 *
 * MEASURED ON AN ANDROID HANDSET 2026-09-21, after a notification tap: the first Back press left
 * the app in the foreground still showing the conversation, and the second exited. From the outside
 * the first press looked like it had done nothing at all.
 */

// This file imports nothing statically - every module it needs arrives through `vi.mock` or a
// dynamic `import`, for the isolation reasons given below. Without this line TypeScript reads
// it as a SCRIPT rather than a module, and a top-level `await` is then an error that only
// `svelte-check` reports - `vitest` and `oxlint` both run the file happily.
export {};

/**
 * The overlay stack is replaced rather than driven, for two reasons: `isMobileOverlayLayout` asks a
 * real media query that no test viewport answers the way a phone does, and the close callback is
 * otherwise reachable only by dispatching a `popstate` - which would test the browser, not this.
 * Capturing the callback IS capturing what the Back button invokes.
 */
const pushed: Array<() => void> = [];
const { pushHistoryOverlay } = vi.hoisted(() => ({ pushHistoryOverlay: vi.fn() }));

vi.mock('$lib/utils/historyOverlayStack', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/historyOverlayStack')>();
  return { ...actual, isMobileOverlayLayout: () => true, pushHistoryOverlay };
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
const { notifNav } = await import('$lib/stores/notifNav.svelte');

const GROUP_ID = 'e4c1f0aa-0000-4000-8000-000000000001';
const KEY = 'SWIPE-CHECK';

beforeEach(() => {
  vi.clearAllMocks();
  pushed.length = 0;
  pushHistoryOverlay.mockImplementation((close: () => void) => pushed.push(close));
  notifNav.clear();
});

/** A composable holding one conversation, keyed by its display name as a group always is. */
function withConversation() {
  const convs = useConversations();
  convs.conversations.set(KEY, {
    id: GROUP_ID,
    name: KEY,
    messages: [],
  } as never);
  return convs;
}

describe('backing out of a notification landing', () => {
  it('ends the landing when the HARDWARE Back press closes the conversation', () => {
    const convs = withConversation();
    notifNav.navigate(GROUP_ID);
    convs.selectConversation(KEY);

    // The landing is still pending while the conversation is displayed: the target is held until it
    // has been SEEN, not until it has been selected once.
    expect(notifNav.pending).toBe(GROUP_ID);
    expect(pushed).toHaveLength(1);

    // This is the Back press. Without the fix the landing survives it and re-selects the target on
    // the effect's very next pass, so the press looks inert on the screen.
    pushed[0]();

    expect(convs.selectedContact).toBeNull();
    expect(notifNav.pending).toBeNull();
  });

  it('agrees with the in-app back control, which is the point', () => {
    // The two exits must not disagree: that they did is the whole defect. This pins them together
    // rather than pinning each one's behaviour separately, so a change to one that forgets the
    // other fails here.
    const viaOverlay = withConversation();
    notifNav.navigate(GROUP_ID);
    viaOverlay.selectConversation(KEY);
    pushed[0]();
    const afterOverlay = { selected: viaOverlay.selectedContact, pending: notifNav.pending };

    pushed.length = 0;
    const viaControl = withConversation();
    notifNav.navigate(GROUP_ID);
    viaControl.selectConversation(KEY);
    viaControl.goBackToMenu();

    expect(afterOverlay).toEqual({
      selected: viaControl.selectedContact,
      pending: notifNav.pending,
    });
  });

  it('leaves a landing for a DIFFERENT target alone', () => {
    // `endLandingUnlessTarget` is not "clear the landing", it is "clear it unless this IS it". A
    // landing published for a conversation nobody has opened yet must survive backing out of the
    // one on screen, or a tap arriving mid-gesture would be swallowed.
    const convs = withConversation();
    const other = 'b1b1b1b1-0000-4000-8000-000000000002';
    convs.selectConversation(KEY);
    notifNav.navigate(other);

    pushed[0]();

    expect(notifNav.pending).toBe(other);
  });
});
