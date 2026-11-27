import { describe, expect, it, vi } from 'vitest';

// The production client's graph (the live chat session, the transports) is not this test's subject.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({ globalSession: { deviceKeyB64: '' } }));
vi.mock('./connect', () => ({ mailStreamOpener: vi.fn(), platformTransport: vi.fn() }));

import { currentMailClient, followMailSwitch, type MailClient } from './mailClient.svelte';

/** The switch turned off ends a client already built (review M5); on, the account's client opens. */

/** A stand-in client: an account that is not eligible, so opening it reads and stops there. */
function fakeClient(userId: string) {
  const end = vi.fn(async () => {});
  const client = {
    userId,
    end,
    readEligibility: vi.fn(async () => {}),
    store: { eligibility: 'not_eligible' },
    session: { state: { kind: 'signed_out' } },
  };
  return { client: client as unknown as MailClient, end };
}

describe('followMailSwitch', () => {
  it('builds the account client while on, and ENDS it when the switch turns off', async () => {
    const { client, end } = fakeClient('user-1');
    followMailSwitch('user-1', true, () => client);
    expect(currentMailClient()).toBe(client);

    followMailSwitch('user-1', false, () => client);
    // The session ends on the server, the sealed password is KEPT (review M-5, decided).
    await vi.waitFor(() =>
      expect(end).toHaveBeenCalledWith('mail switched off', { keepRemembered: true })
    );
    expect(currentMailClient()).toBeNull();
  });

  it('off with no client built does nothing; on with nobody signed in builds nothing', () => {
    const build = vi.fn();
    followMailSwitch('user-1', false, build);
    followMailSwitch(null, true, build);
    expect(build).not.toHaveBeenCalled();
    expect(currentMailClient()).toBeNull();
  });
});
