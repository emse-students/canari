// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { getSavedDisplayName, saveUserLocally } from './user';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

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

/**
 * THE DEVICE COPY OF THE NOTIFICATION SETTINGS IS ONE ACCOUNT'S TOO (`notificationPreferences`): a
 * change of account erases every other account's copy, and keeps the one signing in.
 */
describe('saveUserLocally and the device copies of the notification settings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("erases the previous account's copy on a switch, and keeps the new account's own", () => {
    saveUserLocally({ id: 'gamma' });
    localStorage.setItem(ACCOUNT_KEY.notificationPreferences('gamma'), '{}');
    localStorage.setItem(ACCOUNT_KEY.notificationPreferences('delta'), '{}');
    saveUserLocally({ id: 'delta' });
    expect(localStorage.getItem(ACCOUNT_KEY.notificationPreferences('gamma'))).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.notificationPreferences('delta'))).toBe('{}');
  });

  it('touches nothing when the same account is saved again', () => {
    saveUserLocally({ id: 'gamma' });
    localStorage.setItem(ACCOUNT_KEY.notificationPreferences('gamma'), '{}');
    saveUserLocally({ id: 'gamma' });
    expect(localStorage.getItem(ACCOUNT_KEY.notificationPreferences('gamma'))).toBe('{}');
  });
});
