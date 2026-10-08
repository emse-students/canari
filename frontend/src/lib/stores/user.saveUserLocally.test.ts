import { beforeEach, describe, expect, it } from 'vitest';
import { getSavedDisplayName, saveUserLocally } from './user';

/**
 * THE SAVED DISPLAY NAME IS ONE ACCOUNT'S. The token refresh and the session restore call
 * `saveUserLocally` with no `displayName`; after a switch the previous account's name used to stay
 * and the avatar's label cache then adopted it for the new id (iPhone, 2026-10-07).
 */
describe('saveUserLocally and the saved display name', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('drops the previous account name when the id changes and none is given', () => {
    saveUserLocally({ id: 'gamma', displayName: 'Canari Test Gamma' });
    saveUserLocally({ id: 'delta' });
    expect(getSavedDisplayName()).toBeNull();
  });

  it('keeps the name when the same account is saved again without one', () => {
    saveUserLocally({ id: 'gamma', displayName: 'Canari Test Gamma' });
    saveUserLocally({ id: 'gamma' });
    expect(getSavedDisplayName()).toBe('Canari Test Gamma');
  });

  it('stores the new name on a switch that carries one', () => {
    saveUserLocally({ id: 'gamma', displayName: 'Canari Test Gamma' });
    saveUserLocally({ id: 'delta', displayName: 'Canari Test Delta' });
    expect(getSavedDisplayName()).toBe('Canari Test Delta');
  });
});
