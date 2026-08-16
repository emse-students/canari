/**
 * MUT-19: deleting a message that never left the outbox must not send it.
 *
 * This pins the WIRING, which is the half a test of the outbox alone cannot reach: `cancelPending`
 * can be perfect and the defect survive intact, because the defect was that `deleteMessage` never
 * asked. Both cases are asserted from the same seam - the queue answers whether the frame is still
 * here, and that single answer decides between a withdrawal and a broadcast.
 */
const outboxMock = vi.hoisted(() => ({
  cancelOutboxMessage: vi.fn(async () => false),
  enqueueOutboxMessage: vi.fn(async () => {}),
}));
vi.mock('./outbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./outbox')>()),
  ...outboxMock,
}));

import { deleteMessage } from './messaging';
import { decodeAppMessage } from '$lib/proto/codec';
import type { Conversation } from '$lib/types';

const deps = {
  mlsService: {} as any,
  userId: 'u',
  deviceKeyB64: 'k',
  conversation: { id: 'g1', messages: [] } as unknown as Conversation,
};

/** The system event a queued entry carries, or null when the entry is not one. */
function systemEventOf(call: unknown[]): string | null {
  const entry = call[0] as { kind?: string; controlProto?: Uint8Array };
  if (entry?.kind !== 'control' || !entry.controlProto) return null;
  return decodeAppMessage(entry.controlProto)?.system?.event ?? null;
}

describe('deleteMessage', () => {
  beforeEach(() => {
    outboxMock.cancelOutboxMessage.mockClear();
    outboxMock.enqueueOutboxMessage.mockClear();
  });

  it('withdraws a message still queued, and broadcasts NOTHING about it', async () => {
    outboxMock.cancelOutboxMessage.mockResolvedValueOnce(true);

    const outcome = await deleteMessage('m1', deps);

    expect(outboxMock.cancelOutboxMessage).toHaveBeenCalledWith('m1');
    // The peers never had it. A `delete_message` here is the defect: the flusher would send the
    // text first, so the peer renders a message the user deleted before it hears it is gone.
    expect(outboxMock.enqueueOutboxMessage).not.toHaveBeenCalled();
    // And the caller is TOLD, because its local write differs: a withdrawn message is dropped
    // outright, where a broadcast one keeps its row as a tombstone. Returning nothing is what made
    // the caller tombstone both, leaving the sender a row no peer could ever match.
    expect(outcome).toBe('withdrawn');
  });

  it('broadcasts delete_message once the frame has left this device', async () => {
    outboxMock.cancelOutboxMessage.mockResolvedValueOnce(false);

    const outcome = await deleteMessage('m1', deps);

    expect(outboxMock.enqueueOutboxMessage).toHaveBeenCalledTimes(1);
    expect(systemEventOf(outboxMock.enqueueOutboxMessage.mock.calls[0])).toBe('delete_message');
    expect(outcome).toBe('broadcast');
  });

  it('asks the queue BEFORE enqueuing, never the other way round', async () => {
    const order: string[] = [];
    outboxMock.cancelOutboxMessage.mockImplementationOnce(async () => {
      order.push('cancel');
      return false;
    });
    outboxMock.enqueueOutboxMessage.mockImplementationOnce(async () => {
      order.push('enqueue');
    });

    await deleteMessage('m1', deps);

    // Order is the whole fix. Enqueuing first and cancelling after leaves the text ahead of the
    // tombstone in the very queue that is about to drain.
    expect(order).toEqual(['cancel', 'enqueue']);
  });
});
