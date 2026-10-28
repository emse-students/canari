import { describe, it, expect } from 'vitest';
import { communityLedgerKey, createListingLedger } from './listingLedger';

/**
 * The ledger alone, with explicit ticks: no network, no clock. The composable's own tests drive the
 * same facts through a real listing (`useChannelWorkspaces.svelte.test.ts`).
 */
describe('listingLedger', () => {
  it('answers nothing for a fact older than the request, so the listing decides', () => {
    const ledger = createListingLedger();
    ledger.present('channel_a');
    const askedAt = ledger.tick;
    expect(ledger.learnedSince('channel_a', askedAt)).toBeNull();
    expect(ledger.learnedSince('channel_never', askedAt)).toBeNull();
  });

  it('answers present for a salon heard of after the request', () => {
    const ledger = createListingLedger();
    const askedAt = ledger.tick;
    ledger.present('channel_heard');
    expect(ledger.learnedSince('channel_heard', askedAt)).toBe('present');
  });

  it('answers gone for a removal heard after the request', () => {
    const ledger = createListingLedger();
    ledger.present('channel_x');
    const askedAt = ledger.tick;
    ledger.gone('channel_x');
    expect(ledger.learnedSince('channel_x', askedAt)).toBe('gone');
  });

  it('keeps the LAST fact: removed then heard again is present, heard then removed is gone', () => {
    const ledger = createListingLedger();
    const askedAt = ledger.tick;
    ledger.gone('channel_back');
    ledger.present('channel_back');
    ledger.present('channel_left');
    ledger.gone('channel_left');
    expect(ledger.learnedSince('channel_back', askedAt)).toBe('present');
    expect(ledger.learnedSince('channel_left', askedAt)).toBe('gone');
  });

  it('keeps communities and salons apart in the one record', () => {
    const ledger = createListingLedger();
    const askedAt = ledger.tick;
    ledger.gone(communityLedgerKey('channel_x'));
    expect(ledger.learnedSince('channel_x', askedAt)).toBeNull();
    expect(ledger.learnedSince(communityLedgerKey('channel_x'), askedAt)).toBe('gone');
  });
});
