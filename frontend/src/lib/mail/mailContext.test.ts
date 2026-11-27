import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/auth', () => ({
  schoolMailAddress: vi.fn(async () => 'jane.doe@etu.emse.fr'),
}));

import { schoolMailAddress } from '$lib/stores/auth';
import { canariMailContext } from './mailContext';

/** The mail session reads the account's school address from the sign-in, and nowhere else. */
describe('canariMailContext', () => {
  it('names the school address the MiConnect sign-in stored, the account id and its device key', async () => {
    const context = canariMailContext('user-1', () => 'key');
    expect(context.userId).toBe('user-1');
    expect(context.deviceKey()).toBe('key');
    expect(await context.mailAddress()).toBe('jane.doe@etu.emse.fr');
    expect(schoolMailAddress).toHaveBeenCalledOnce();
  });
});
