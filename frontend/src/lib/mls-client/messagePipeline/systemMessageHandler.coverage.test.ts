import { digestIdentity } from '$lib/utils/chat/historyDigestRendezvous';

/**
 * The frame that carries the fourth trigger: a peer stating where its OWN history begins.
 *
 * It is the only leg of the exchange that is an ANSWER ABOUT THE ANSWERER rather than about the
 * messages, and everything below pins one property of that: it must be believed only from the
 * device the election named, measured against THIS device's window rather than the one echoed back,
 * and it must never be read as a shortfall when it is not one.
 */
const { noteCoverageShortfall, historyRangeStartFor } = vi.hoisted(() => ({
  noteCoverageShortfall: vi.fn().mockResolvedValue(undefined),
  historyRangeStartFor: vi.fn(),
}));
vi.mock('$lib/utils/chat/historyReconcile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/historyReconcile')>()),
  noteCoverageShortfall,
}));
vi.mock('$lib/utils/chat/groupActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/groupActions')>()),
  historyRangeStartFor,
}));

import { handleSystemEvent } from './systemMessageHandler';

const ME = 'me';
const MY_DEVICE = 'device-me';
const GROUP = 'g1';
const PEER = 'peer';
const PEER_IDENTITY = digestIdentity(PEER, 'device-peer');

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
/** What THIS device wants: five years of past. */
const OUR_SINCE = NOW - 5 * 365 * DAY;
/** What the peer can supply: ninety days, and not an hour more. */
const THEIR_COVERAGE = NOW - 90 * DAY;

function makeCtx(overrides: Record<string, unknown> = {}) {
  const conversations = new Map<string, any>();
  conversations.set(GROUP, { id: GROUP, unreadCount: 0, messages: [] });
  return {
    mlsService: { getDeviceId: () => MY_DEVICE },
    storage: {},
    userId: ME,
    deviceKeyB64: 'device-key',
    conversations,
    messageReactions: new Map(),
    addMessageToChat: vi.fn(),
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convo: conversations.get(GROUP),
    convoKey: GROUP,
    senderNorm: PEER,
    persistMlsStateNow: vi.fn(),
    ...overrides,
  };
}

const frame = (over: Record<string, unknown> = {}) => ({
  from: PEER_IDENTITY,
  to: digestIdentity(ME, MY_DEVICE),
  since: OUR_SINCE,
  coveredFrom: THEIR_COVERAGE,
  ...over,
});

beforeEach(() => {
  noteCoverageShortfall.mockClear();
  historyRangeStartFor.mockResolvedValue(OUR_SINCE);
});

describe('history_coverage', () => {
  it('raises the trigger with the coverage the peer stated', async () => {
    await handleSystemEvent('history_coverage', frame(), makeCtx() as any);

    expect(noteCoverageShortfall).toHaveBeenCalledWith(
      expect.anything(),
      GROUP,
      PEER_IDENTITY,
      { since: OUR_SINCE, coveredFrom: THEIR_COVERAGE },
      expect.any(Function)
    );
  });

  it('measures it against OUR window, not the one the peer echoed back', async () => {
    // The echo is what the peer compared against - one round trip old, and either side of midnight
    // a different day. The question this answers is "does that peer cover what THIS device wants",
    // and only this device is entitled to say what that is.
    historyRangeStartFor.mockResolvedValue(NOW - 365 * DAY);

    await handleSystemEvent('history_coverage', frame({ since: 12345 }), makeCtx() as any);

    expect(noteCoverageShortfall).toHaveBeenCalledWith(
      expect.anything(),
      GROUP,
      PEER_IDENTITY,
      { since: NOW - 365 * DAY, coveredFrom: THEIR_COVERAGE },
      expect.any(Function)
    );
  });

  it('ignores an answer addressed at another device', async () => {
    // Every leg of this exchange is a group broadcast. A coverage line meant for a peer describes a
    // window that peer asked for, and acting on it would send this device chasing a gap it has not
    // got.
    await handleSystemEvent(
      'history_coverage',
      frame({ to: digestIdentity('someone-else', 'their-device') }),
      makeCtx() as any
    );

    expect(noteCoverageShortfall).not.toHaveBeenCalled();
  });

  it('refuses a `from` that does not match the authenticated MLS sender', async () => {
    await handleSystemEvent(
      'history_coverage',
      frame({ from: digestIdentity('impostor', 'device-x') }),
      makeCtx() as any
    );

    expect(noteCoverageShortfall).not.toHaveBeenCalled();
  });

  it.each([['not a number'], [0], [-1], [undefined]])(
    'reports rather than acts on an unusable coveredFrom (%s)',
    async (coveredFrom) => {
      const ctx = makeCtx();

      await handleSystemEvent('history_coverage', frame({ coveredFrom }), ctx as any);

      expect(noteCoverageShortfall).not.toHaveBeenCalled();
      expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('Unusable coverage'));
    }
  );

  it('acknowledges the frame whatever it decided, so the queue is never blocked by one', async () => {
    expect(await handleSystemEvent('history_coverage', frame(), makeCtx() as any)).toBe(true);
    expect(
      await handleSystemEvent('history_coverage', frame({ coveredFrom: null }), makeCtx() as any)
    ).toBe(true);
  });
});
