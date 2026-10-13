import { buildHistoryDigest } from './historyManifest';
import { pullFromOverheardDigest } from './historyDiffAnswer';
import {
  forgetOwedPulls,
  owedPullCount,
  owedPullTicket,
  resetOwedPulls,
  takeOwedPulls,
} from './historyOverheardPull';
import {
  liveProofOfAuthor,
  retryPullsOwedTo,
} from '$lib/mls-client/messagePipeline/setupMessageHandler';

/**
 * THE ONE RETRY OF AN OVERHEARD-DIGEST PULL. A pull is a transport frame, dropped when the author has
 * already gone; the retry fires on the author's next LIVE frame, once, and never on a clock.
 */

const { readHistoryEntries, sendHistoryPull, historyRangeStartFor } = vi.hoisted(() => ({
  readHistoryEntries: vi.fn(),
  sendHistoryPull: vi.fn().mockResolvedValue(undefined),
  historyRangeStartFor: vi.fn(),
}));
vi.mock('$lib/utils/chat/groupActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/groupActions')>()),
  readHistoryEntries,
  sendHistoryPull,
  historyRangeStartFor,
}));

const GROUP = 'g1';
const OTHER_GROUP = 'g2';
const AUTHOR = 'peer:device-peer';
const SELF = 'me:device-me';
const entry = (id: string) => ({ id, timestamp: 1 });

const log = vi.fn();
const answerDeps = () => ({ storage: null, deviceKeyB64: 'k', mlsService: {} as any, log });
const handlerDeps = () =>
  ({
    mlsService: {
      getDeviceId: () => 'device-me',
      waitForGroupQueueIdle: vi.fn().mockResolvedValue(undefined),
    },
    storage: null,
    deviceKey: () => 'k',
    userId: 'me',
    log,
  }) as any;

/** Lets the `void`-ed chain behind `answerAfterMailboxDrained` run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

async function overhear(ids: string[], groupId = GROUP): Promise<void> {
  await pullFromOverheardDigest({
    groupId,
    holderIdentity: AUTHOR,
    selfIdentity: SELF,
    digest: await buildHistoryDigest(ids.map(entry)),
    ticket: owedPullTicket(groupId),
    deps: answerDeps(),
  });
}

/** The author's next live frame, as the pipeline hands it over. */
async function authorSpeaksLive(): Promise<void> {
  retryPullsOwedTo(AUTHOR, handlerDeps());
  await settle();
}

const pulledIds = () => sendHistoryPull.mock.calls.map((c) => c[1].ids);

beforeEach(() => {
  resetOwedPulls();
  readHistoryEntries.mockReset();
  sendHistoryPull.mockClear();
  historyRangeStartFor.mockReset().mockResolvedValue(0);
  log.mockClear();
});

describe('the owed retry of an overheard-digest pull', () => {
  it('sends nothing and does not grow while the author never comes back', async () => {
    readHistoryEntries.mockResolvedValue([entry('a')]);
    for (let i = 0; i < 5; i++) await overhear(['a', 'g']);

    // Five digests, five first asks - and ONE entry, however many the author sends.
    expect(sendHistoryPull).toHaveBeenCalledTimes(5);
    expect(owedPullCount()).toBe(1);
  });

  it('retries only the NEWEST digest when two arrived', async () => {
    readHistoryEntries.mockResolvedValue([entry('a')]);
    await overhear(['a', 'g']);
    await overhear(['a', 'h']);
    sendHistoryPull.mockClear();

    await authorSpeaksLive();

    expect(pulledIds()).toEqual([['h']]);
  });

  it('retries ONCE, however many live frames follow', async () => {
    readHistoryEntries.mockResolvedValue([entry('a')]);
    await overhear(['a', 'g']);
    sendHistoryPull.mockClear();

    await authorSpeaksLive();
    await authorSpeaksLive();
    await authorSpeaksLive();

    expect(sendHistoryPull).toHaveBeenCalledTimes(1);
    expect(owedPullCount()).toBe(0);
  });

  it('does not loop on ids the author will never send (below our window): two asks, then none', async () => {
    // The author clips them and answers NOTHING, so "until answered" would never end.
    readHistoryEntries.mockResolvedValue([entry('a')]);
    await overhear(['a', 'old']);
    for (let i = 0; i < 4; i++) await authorSpeaksLive();

    expect(pulledIds()).toEqual([['old'], ['old']]);
  });

  it('asks nothing on the retry when the first ask was answered meanwhile', async () => {
    readHistoryEntries.mockResolvedValue([entry('a')]);
    await overhear(['a', 'g']);
    // The author's bundle landed: the retry diffs the store as it is NOW.
    readHistoryEntries.mockResolvedValue([entry('a'), entry('g')]);
    sendHistoryPull.mockClear();

    await authorSpeaksLive();

    expect(sendHistoryPull).not.toHaveBeenCalled();
    expect(owedPullCount()).toBe(0);
  });

  it('drops the entry when a newer digest leaves nothing to ask', async () => {
    readHistoryEntries.mockResolvedValue([entry('a')]);
    await overhear(['a', 'g']);
    await overhear(['a']);

    expect(owedPullCount()).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('retry dropped'));
  });

  it('is emptied by a sign-out, and a pull in flight across it records nothing', async () => {
    readHistoryEntries.mockResolvedValue([entry('a')]);
    await overhear(['a', 'g']);
    const ticketFromBefore = owedPullTicket(GROUP);
    resetOwedPulls();
    expect(owedPullCount()).toBe(0);

    await pullFromOverheardDigest({
      groupId: GROUP,
      holderIdentity: AUTHOR,
      selfIdentity: SELF,
      digest: await buildHistoryDigest([entry('a'), entry('g')]),
      ticket: ticketFromBefore,
      deps: answerDeps(),
    });

    expect(owedPullCount()).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('outlived its session'));
  });

  it('forgets a conversation that was left, and only that one', async () => {
    readHistoryEntries.mockResolvedValue([entry('a')]);
    await overhear(['a', 'g'], GROUP);
    await overhear(['a', 'g'], OTHER_GROUP);
    const staleTicket = owedPullTicket(GROUP);

    forgetOwedPulls(GROUP);

    expect(takeOwedPulls(AUTHOR).map((o) => o.groupId)).toEqual([OTHER_GROUP]);
    await pullFromOverheardDigest({
      groupId: GROUP,
      holderIdentity: AUTHOR,
      selfIdentity: SELF,
      digest: await buildHistoryDigest([entry('a'), entry('g')]),
      ticket: staleTicket,
      deps: answerDeps(),
    });
    expect(owedPullCount()).toBe(0);
  });

  it('owes nothing for a digest this road declines', async () => {
    readHistoryEntries.mockResolvedValue([entry('a')]);
    await pullFromOverheardDigest({
      groupId: GROUP,
      holderIdentity: AUTHOR,
      selfIdentity: SELF,
      digest: await buildHistoryDigest([entry('a'), entry('b'), entry('c')], 1),
      ticket: owedPullTicket(GROUP),
      deps: answerDeps(),
    });

    expect(owedPullCount()).toBe(0);
  });
});

describe('liveProofOfAuthor', () => {
  it('names the device of a LIVE frame', () => {
    expect(
      liveProofOfAuthor('peer', { channel: 'live', senderDeviceId: 'device-peer' }, undefined)
    ).toBe(AUTHOR);
  });

  it('proves nothing for a PULLED copy - a queue row may be hours old', () => {
    expect(
      liveProofOfAuthor('peer', { channel: 'pull', senderDeviceId: 'device-peer' }, undefined)
    ).toBeNull();
  });

  it('proves nothing without a device to address', () => {
    expect(liveProofOfAuthor('peer', { channel: 'live' }, undefined)).toBeNull();
  });

  it("does not spend the entry on the author's own digest, which supersedes it", () => {
    expect(
      liveProofOfAuthor(
        'peer',
        { channel: 'live', senderDeviceId: 'device-peer' },
        'history_digest'
      )
    ).toBeNull();
  });
});
