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

  it('a row is sent only when it carries what a delivery writes on it', () => {
    const signed = { authorship: {} as never };
    expect(settlementHeld(null, signed)).toBe('sent');
    expect(settlementHeld(null, { serverTimestamp: 42 })).toBe('sent');
    expect(settlementHeld(null, { ...signed, unsentReason: 'not-a-member' })).toBe('failed');
  });

  it('a row with no entry and no delivery on it NEVER LEFT - failed, with its Retry (round-3 review)', () => {
    // The TAB-5 orphan: the echo written, the process dead before its entry was. Drawing it
    // answered would tell the member a reply went that never did.
    expect(settlementHeld(null, {})).toBe('failed');
  });

  it('nothing held is null - the one case a reply is lost', () => {
    expect(settlementHeld(null, null)).toBeNull();
  });
});
