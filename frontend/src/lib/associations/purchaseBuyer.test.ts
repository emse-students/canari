import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { purchaseBuyerName } from './purchaseBuyer';

describe('purchaseBuyerName', () => {
  it('names a guest payment (no account) as a guest, never as a blank or an id', () => {
    expect(purchaseBuyerName({ firstName: null, lastName: null, userId: null })).toBe(
      m.form_submitter_guest()
    );
  });

  it('prefers the name the server joined', () => {
    expect(purchaseBuyerName({ firstName: 'Ada', lastName: 'Lovelace', userId: 'u1' })).toBe(
      'Ada Lovelace'
    );
  });
});
