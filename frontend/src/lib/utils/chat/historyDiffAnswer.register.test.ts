import { buildHistoryDigest } from './historyManifest';
import { answerHistoryDigest } from './historyDiffAnswer';

/**
 * The elected responder answers a REGISTER digest (`registerOwed.ts`) with the state FIRST - one
 * sealed frame that does not close the ask - and the diff after it, whose last chunk does.
 */
const order: string[] = [];
const { readHistoryEntries, sendHistoryBundleForIds, sendRegisterAnswer, historyRangeStartFor } =
  vi.hoisted(() => ({
    readHistoryEntries: vi.fn(),
    sendHistoryBundleForIds: vi.fn(),
    sendRegisterAnswer: vi.fn(),
    historyRangeStartFor: vi.fn(),
  }));
vi.mock('$lib/utils/chat/groupActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/groupActions')>()),
  readHistoryEntries,
  sendHistoryBundleForIds,
  sendRegisterAnswer,
  historyRangeStartFor,
}));

const GROUP = 'g1';
const ASKER = 'peer:device-peer';
const SELF = 'me:device-me';
const KEY = 'a'.repeat(43) + '=';

function deps() {
  return { storage: null, deviceKeyB64: 'k', mlsService: {} as any, log: vi.fn() };
}

async function answer(opts: { register: boolean; answerKey?: string }) {
  await answerHistoryDigest({
    groupId: GROUP,
    requesterIdentity: ASKER,
    selfIdentity: SELF,
    digest: await buildHistoryDigest([]),
    since: 0,
    requestId: 'req-0000000a',
    ...(opts.answerKey !== undefined ? { answerKey: opts.answerKey } : {}),
    register: opts.register,
    deps: deps(),
  });
}

beforeEach(() => {
  order.length = 0;
  readHistoryEntries.mockReset().mockResolvedValue([]);
  historyRangeStartFor.mockReset().mockResolvedValue(0);
  sendRegisterAnswer.mockReset().mockImplementation(async () => {
    order.push('register');
    return true;
  });
  sendHistoryBundleForIds.mockReset().mockImplementation(async () => {
    order.push('diff');
  });
});
afterEach(() => vi.restoreAllMocks());

describe('answerHistoryDigest - a register digest', () => {
  it('sends the register, sealed to the ask and bound to this answerer, BEFORE the diff', async () => {
    await answer({ register: true, answerKey: KEY });

    expect(order).toEqual(['register', 'diff']);
    expect(sendRegisterAnswer).toHaveBeenCalledWith(GROUP, expect.anything(), {
      to: ASKER,
      requestId: 'req-0000000a',
      seal: { answerKey: KEY, answerer: SELF },
    });
  });

  it('sends no register to an ordinary digest', async () => {
    await answer({ register: false, answerKey: KEY });

    expect(sendRegisterAnswer).not.toHaveBeenCalled();
    expect(order).toEqual(['diff']);
  });

  it('a register digest with NO key gets no state, said at error - and still its diff', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await answer({ register: true });

    expect(sendRegisterAnswer).not.toHaveBeenCalled();
    expect(order).toEqual(['diff']);
    expect(error.mock.calls.join(' ')).toContain('with no key');
  });
});
