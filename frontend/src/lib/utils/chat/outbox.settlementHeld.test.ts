import { describe, expect, it } from 'vitest';
import type { OutboxEntry } from '$lib/db';
import { MAX_CONSECUTIVE_SERVER_ERRORS, settlementHeld } from './outbox';

/**
 * WHAT THE DISK SAYS OF ONE MESSAGE - the settlement of a quick reply whose acknowledgement was lost
 * (`quickReplyDrain.ts`, review of #3927). Calling a reply the page holds "lost" drew "retype it"
 * over a reply that had been sent, and the member sent it twice; so only NOTHING held is `null`.
 */
const entry = (extra: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id: 'r-1',
  conversationId: 'g1',
  sentAt: 1,
  kind: 'text',
  text: 'hi',
  status: 'pending',
  attempts: 0,
  createdAt: 1,
  ...extra,
});

describe('settlementHeld', () => {
  it('a queued entry is pending, and failed once parked for the member', () => {
    expect(settlementHeld(entry(), null)).toBe('pending');
    expect(settlementHeld(entry({ serverErrors: MAX_CONSECUTIVE_SERVER_ERRORS }), null)).toBe(
      'failed'
    );
  });

  it('a row with no entry left is sent, or failed when an unsent reason was recorded', () => {
    expect(settlementHeld(null, {})).toBe('sent');
    expect(settlementHeld(null, { unsentReason: 'not-a-member' })).toBe('failed');
  });

  it('nothing held is null - the one case a reply is lost', () => {
    expect(settlementHeld(null, null)).toBeNull();
  });
});
