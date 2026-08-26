import { describe, expect, it } from 'vitest';
import { cotisationGrantBlocker } from './cotisationSettings';

/**
 * "Donner un statut avec le paiement" is hidden behind four conditions ANDed together, and the
 * screen showed one sentence naming three of them. The fourth - the right to manage members - is
 * not a form setting at all, so a manager who held everything else was told the option was
 * "available on a paid form whose association runs memberships" while looking at exactly that.
 *
 * These tests pin the REASON, and its order: the manager must be pointed at the one thing to do
 * next, and three of the four are fixable from that very screen.
 */
describe('cotisation grant blocker', () => {
  it('offers the grant when all four conditions hold', () => {
    expect(cotisationGrantBlocker(true, 'asso-1', 2, true)).toBeNull();
  });

  it('names the payment first, because it is the switch one block up', () => {
    expect(cotisationGrantBlocker(false, '', 0, false)).toBe('no-payment');
  });

  it('names the beneficiary once the form is paid', () => {
    expect(cotisationGrantBlocker(true, '', 0, false)).toBe('no-association');
  });

  it('names the empty catalogue once a beneficiary is chosen', () => {
    expect(cotisationGrantBlocker(true, 'asso-1', 0, false)).toBe('no-cotisation');
  });

  // The one the manager cannot fix here, and the one nothing used to name.
  it('names the missing right last, when nothing else is wrong', () => {
    expect(cotisationGrantBlocker(true, 'asso-1', 2, false)).toBe('no-right');
  });
});
