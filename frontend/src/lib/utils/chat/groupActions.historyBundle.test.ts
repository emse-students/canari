import { sendFullHistoryBundle, sendHistoryBundleForIds } from './groupActions';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { decodeAppMessage } from '$lib/proto/codec';
import type { IStorage, StoredMessage } from '$lib/db';

const GROUP = 'g1';
/** The device that asked - every bundle is addressed at one, never at the group at large. */
const REQUESTER = 'user-b:device-b';

function storageWith(messages: StoredMessage[] | Error): IStorage {
  return {
    getMessages: vi
      .fn()
      .mockImplementation(() =>
        messages instanceof Error ? Promise.reject(messages) : Promise.resolve(messages)
      ),
  } as unknown as IStorage;
}

function storedMessage(id: string, timestamp = 1_700_000_000_000): StoredMessage {
  return {
    id,
    senderId: 'user-b',
    content: 'hello',
    timestamp,
  } as StoredMessage;
}

/** Decodes the `history_bundle` payload of the single message the stub was asked to send. */
function sentBundle(mlsService: ReturnType<typeof createMlsServiceStub>) {
  const bytes = vi.mocked(mlsService.sendMessage).mock.calls[0][1] as Uint8Array;
  const decoded = decodeAppMessage(bytes);
  return {
    event: decoded?.system?.event,
    data: JSON.parse(decoded?.system?.data || '{}') as { messages: unknown[]; to?: string },
  };
}

describe('sendFullHistoryBundle', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('answers an empty group with an empty bundle, which carries the floor and the watermarks', async () => {
    // The ONE empty bundle still worth a frame: the receiver is a member being invited, so it has
    // no conversation row at all and this is what gives it one.
    const mlsService = createMlsServiceStub();
    await sendFullHistoryBundle(GROUP, {
      storage: storageWith([]),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
      to: REQUESTER,
    });

    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    const { event, data } = sentBundle(mlsService);
    expect(event).toBe('history_bundle');
    expect(data.messages).toEqual([]);
    expect(data.to).toBe(REQUESTER);
  });

  it('stays silent when the local read fails - a failed read proves nothing', async () => {
    const mlsService = createMlsServiceStub();
    await sendFullHistoryBundle(GROUP, {
      storage: storageWith(new Error('sqlite locked')),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
      to: REQUESTER,
    });

    expect(mlsService.sendMessage).not.toHaveBeenCalled();
  });

  it('sends the real history when there is some', async () => {
    const mlsService = createMlsServiceStub();
    await sendFullHistoryBundle(GROUP, {
      storage: storageWith([storedMessage('m1'), storedMessage('m2')]),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
      to: REQUESTER,
    });

    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    const { event, data } = sentBundle(mlsService);
    expect(event).toBe('history_bundle');
    expect(data.messages).toHaveLength(2);
    expect(data.to).toBe(REQUESTER);
  });

  it('carries the edit time with the edit flag, and every reaction including the withdrawn ones', async () => {
    // Two things a device restored from a bundle has NO other source for. `isEdited` without
    // `editedAt` showed "edited" with no time for ever, since the sender's own edit is never
    // echoed back over MLS (D4). And a reaction taken back is an entry carrying its removal time -
    // dropping it from the bundle would hand the receiver back the placement it had removed (D3).
    const mlsService = createMlsServiceStub();
    const edited = {
      ...storedMessage('m1'),
      isEdited: true,
      editedAt: 1_700_000_042_000,
      reactions: [
        { emoji: '👍', userId: 'user-b', at: 10, removed: true },
        { emoji: '🎉', userId: 'user-c', at: 20 },
      ],
    } as StoredMessage;

    await sendFullHistoryBundle(GROUP, {
      storage: storageWith([edited]),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
      to: REQUESTER,
    });

    const { data } = sentBundle(mlsService);
    expect(data.messages[0]).toMatchObject({
      isEdited: true,
      editedAt: 1_700_000_042_000,
      reactions: [
        { emoji: '👍', userId: 'user-b', at: 10, removed: true },
        { emoji: '🎉', userId: 'user-c', at: 20 },
      ],
    });
  });
});

describe("sendHistoryBundleForIds - the asker's window", () => {
  // The clip lives HERE and nowhere else, because this is the only place holding both the messages
  // and their timestamps: an id list carries no dates, so no caller upstream could apply it.

  const OLD = 1_600_000_000_000;
  const RECENT = 1_700_000_000_000;
  const SINCE = 1_650_000_000_000;

  /** Every id in `msgs`, so a test asks for the whole selection and only the clip narrows it. */
  const allIds = (msgs: StoredMessage[]) => msgs.map((m) => m.id);

  function serve(msgs: StoredMessage[], since: number) {
    const mlsService = createMlsServiceStub();
    return {
      mlsService,
      done: sendHistoryBundleForIds(
        GROUP,
        allIds(msgs),
        { storage: storageWith(msgs), deviceKeyB64: 'k', mlsService, log: vi.fn() },
        { to: REQUESTER, since }
      ),
    };
  }

  it('drops what falls below the stated window and sends the rest', async () => {
    const { mlsService, done } = serve(
      [storedMessage('old', OLD), storedMessage('new', RECENT)],
      SINCE
    );
    await done;

    const { data } = sentBundle(mlsService);
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]).toMatchObject({ id: 'new' });
  });

  it('includes the boundary itself - `since` is the first instant asked for, not the last refused', async () => {
    const { mlsService, done } = serve([storedMessage('exactly-at', SINCE)], SINCE);
    await done;

    expect(data0(mlsService)).toMatchObject({ id: 'exactly-at' });
  });

  it('answers in full for an asker whose window opens at the beginning', async () => {
    // 0 is a WINDOW, not the absence of one, and that distinction is the point: `since` used to
    // default to 0 so that an ask stating nothing was still served in full. Nothing reaches this
    // without one - every ask carries it, and the invite push uses `sendFullHistoryBundle` instead -
    // so the default could only ever have answered a malformed frame while looking like a normal one.
    const { mlsService, done } = serve(
      [storedMessage('old', OLD), storedMessage('new', RECENT)],
      0
    );
    await done;

    expect(sentBundle(mlsService).data.messages).toHaveLength(2);
  });

  it('sends NOTHING when the clip is what emptied the answer', async () => {
    // An empty bundle used to be an answer - "you are missing nothing" - because a durable marker
    // on the other side needed something authoritative to discharge it. There is no marker: a
    // device that receives nothing keeps what it holds and compares again on its next connection.
    const { mlsService, done } = serve([storedMessage('old', OLD)], SINCE);
    await done;

    expect(mlsService.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps a message whose timestamp cannot be compared, rather than silently dropping it', async () => {
    // An unusable date is not evidence that a message is old. The range exists to bound what is
    // sent; a value nothing can be concluded from must not decide against the message.
    const { mlsService, done } = serve(
      [storedMessage('undated', undefined as unknown as number)],
      SINCE
    );
    await done;

    expect(data0(mlsService)).toMatchObject({ id: 'undated' });
  });

  /** First message of the single bundle the stub was asked to send. */
  function data0(mlsService: ReturnType<typeof createMlsServiceStub>) {
    return sentBundle(mlsService).data.messages[0];
  }
});
