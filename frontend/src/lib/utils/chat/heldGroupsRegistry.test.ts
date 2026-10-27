// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_KEY, accountLocalStorageKeysIn } from '../accountLocalKeys';
import { onceHeldGroup, recordHeldGroup } from './heldGroupsRegistry';

/** The groups a device once held and dropped - what lets its recovery take its own door. */
describe('heldGroupsRegistry', () => {
  afterEach(() => localStorage.clear());

  it('remembers a dropped group per DEVICE, once', () => {
    recordHeldGroup('dev-a', 'g1');
    recordHeldGroup('dev-a', 'g1');

    expect(onceHeldGroup('dev-a', 'g1')).toBe(true);
    expect(onceHeldGroup('dev-b', 'g1')).toBe(false);
    expect(JSON.parse(localStorage.getItem(ACCOUNT_KEY.heldGroups('dev-a'))!)).toEqual(['g1']);
  });

  it('is swept with the account that names the device, and only that one', () => {
    localStorage.setItem(ACCOUNT_KEY.deviceId('alice'), 'dev-a');
    localStorage.setItem(ACCOUNT_KEY.retiringDeviceIds('alice'), JSON.stringify(['dev-old']));
    localStorage.setItem(ACCOUNT_KEY.deviceId('dave'), 'dev-d');
    for (const device of ['dev-a', 'dev-old', 'dev-d']) recordHeldGroup(device, 'g1');

    const swept = accountLocalStorageKeysIn(localStorage, 'alice');

    expect(swept).toContain(ACCOUNT_KEY.heldGroups('dev-a'));
    expect(swept).toContain(ACCOUNT_KEY.heldGroups('dev-old'));
    expect(swept).not.toContain(ACCOUNT_KEY.heldGroups('dev-d'));
  });
});
