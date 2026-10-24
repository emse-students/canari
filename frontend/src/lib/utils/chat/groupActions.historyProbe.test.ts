// @vitest-environment happy-dom
import { sendHistoryProbe } from './groupActions';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { decodeAppMessage } from '$lib/proto/codec';
import type { IStorage, StoredMessage } from '$lib/db';

/**
 * The first leg of a reconciliation, and the one leg it chooses: a state key when this device holds
 * something, the digest straight away when it holds nothing - which is how every group looks right
 * after a sign-in, and where the state key only ever earned a "describe yourself" round trip.
 */

const GROUP = 'g1';
const SELF = 'user-a:device-a';

function storageHolding(count: number | Error, messages: StoredMessage[] = []): IStorage {
  return {
    countMessages: vi
      .fn()
      .mockImplementation(() =>
        count instanceof Error ? Promise.reject(count) : Promise.resolve(count)
      ),
    getMessages: vi.fn().mockResolvedValue(messages),
    getConversation: vi.fn().mockResolvedValue(undefined),
  } as unknown as IStorage;
}

function sentEvents(mlsService: ReturnType<typeof createMlsServiceStub>): string[] {
  return vi
    .mocked(mlsService.sendMessage)
    .mock.calls.map((call) => decodeAppMessage(call[1] as Uint8Array)?.system?.event ?? '?');
}

describe('sendHistoryProbe', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('sends the DIGEST at once when the store holds nothing - one round trip, not two', async () => {
    const mlsService = createMlsServiceStub();
    const sent = await sendHistoryProbe(GROUP, SELF, {
      storage: storageHolding(0),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
    });

    expect(sent).toBe(true);
    expect(sentEvents(mlsService)).toEqual(['history_digest']);
  });

  it('keeps the STATE KEY when the store holds anything - agreement is likely and costs one frame', async () => {
    const mlsService = createMlsServiceStub();
    const held = [
      { id: 'm1', senderId: 'u', content: 'x', timestamp: Date.now() } as StoredMessage,
    ];
    await sendHistoryProbe(GROUP, SELF, {
      storage: storageHolding(1, held),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
    });

    expect(sentEvents(mlsService)).toEqual(['history_state']);
  });

  it('reads a count it could not take as "unknown", never as "empty", and says so', async () => {
    const mlsService = createMlsServiceStub();
    const log = vi.fn();
    await sendHistoryProbe(GROUP, SELF, {
      storage: storageHolding(new Error('disk gone')),
      deviceKeyB64: 'k',
      mlsService,
      log,
    });

    expect(sentEvents(mlsService)).toEqual(['history_state']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Could not count'));
  });
});
