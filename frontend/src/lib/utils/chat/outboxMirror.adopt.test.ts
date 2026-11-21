import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/sessionLog', () => ({ appendLog: vi.fn() }));

import type { OutboxEntry } from '$lib/db';
import { toBase64 } from '$lib/utils/hex';
import { buildOutboxProto, isServerFailureTerminal } from './outbox';
import { adoptMirrorEntry, type OutboxMirrorEntry } from './outboxMirror';

/**
 * AN ENTRY THE NATIVE DRAIN MARKED UNSENDABLE IS ADOPTED FAILED, NEVER DROPPED (review of #3928):
 * the drains skip it from the moment it is marked, so the page is where the member sees it - failed,
 * with its Retry - and decides.
 */
const text: OutboxEntry = {
  id: 'm1',
  conversationId: 'g1',
  sentAt: 1_000,
  kind: 'text',
  text: 'hello',
  status: 'pending',
  attempts: 0,
  createdAt: 1_000,
};

const mirrorOf = (extra: Partial<OutboxMirrorEntry> = {}): OutboxMirrorEntry => ({
  id: 'm1',
  groupId: 'g1',
  proto: toBase64(buildOutboxProto(text)!),
  sentAt: 1_000,
  silent: false,
  durable: true,
  ...extra,
});

describe('adoptMirrorEntry', () => {
  it('adopts a native entry pending - the flusher sends it', () => {
    const adopted = adoptMirrorEntry(mirrorOf(), 'me');
    expect(adopted?.outbox).toMatchObject({ id: 'm1', kind: 'text', text: 'hello' });
    expect(isServerFailureTerminal(adopted!.outbox)).toBe(false);
    expect(adopted?.message).toMatchObject({ id: 'm1', content: 'hello' });
  });

  it('adopts an entry marked unsendable FAILED, with its Retry, and keeps its local copy', () => {
    const adopted = adoptMirrorEntry(mirrorOf({ unsendable: true }), 'me');
    expect(adopted?.outbox).toMatchObject({ id: 'm1', kind: 'text', text: 'hello' });
    expect(isServerFailureTerminal(adopted!.outbox)).toBe(true);
    expect(adopted?.message).toMatchObject({ id: 'm1', content: 'hello' });
  });

  it('adopts an unsendable control frame pending - it has no bubble to fail on', () => {
    const adopted = adoptMirrorEntry(mirrorOf({ silent: true, unsendable: true }), 'me');
    expect(adopted?.outbox.kind).toBe('control');
    expect(adopted?.outbox.serverErrors).toBeUndefined();
    expect(adopted?.message).toBeNull();
  });
});
