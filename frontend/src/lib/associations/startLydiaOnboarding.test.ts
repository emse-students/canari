import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A REFUSED ONBOARDING REACHES THE SCREEN AS A TYPED ERROR. `startLydiaOnboarding` used to throw a
 * plain `Error` whose message was core's English sentence, so the form could only print it; the
 * re-run 409 is now a `SocialApiError` carrying its `code`, and the form branches on that.
 */

const apiFetchMock = vi.fn();
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('$lib/stores/auth', () => ({ getToken: () => 'tok' }));
vi.mock('$lib/utils/apiUrl', () => ({
  coreUrl: () => '',
  socialUrl: () => '',
  mediaUrl: () => '',
}));

const { startLydiaOnboarding, SocialApiError, LYDIA_ONBOARDING_DEADLINE_MS } =
  await import('./api');
const { LYDIA_ONBOARDING_REFUSAL, lydiaOnboardingRefusalCode, lydiaOnboardingOutcomeUnknown } =
  await import('./lydiaOnboardingRefusal');

const profile = {
  name: 'BDE',
  address: '1 rue',
  zipcode: '42000',
  city: 'SE',
  country: 'France',
  businessEmail: 'b@test.example',
  businessPhone: '+33100000000',
};

describe('startLydiaOnboarding - a refusal is typed at the throw', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('throws a SocialApiError carrying the 409 re-run code, whatever the sentence says', async () => {
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ code: 'LYDIA_ACCOUNT_ALREADY_LINKED', message: 'some other words' }),
        { status: 409, headers: { 'content-type': 'application/json' } }
      )
    );
    const err = await startLydiaOnboarding('asso-1', profile).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialApiError);
    expect((err as InstanceType<typeof SocialApiError>).status).toBe(409);
    expect(lydiaOnboardingRefusalCode(err)).toBe(LYDIA_ONBOARDING_REFUSAL.ALREADY_LINKED);
  });

  it('a 409 without the code is not read as a re-run', async () => {
    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: 'A Lydia Business is already linked' }), {
        status: 409,
      })
    );
    const err = await startLydiaOnboarding('asso-1', profile).catch((e: unknown) => e);
    expect(lydiaOnboardingRefusalCode(err)).toBeNull();
  });

  it('answers the public pair on success', async () => {
    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ url: 'https://lydia.example/d', accountId: 'vendor-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await expect(startLydiaOnboarding('asso-1', profile)).resolves.toEqual({
      url: 'https://lydia.example/d',
      accountId: 'vendor-1',
    });
  });

  it('waits longer than nginx (60 s) and core (55 s), so the screen gets their answer, not its own deadline', async () => {
    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ url: 'https://lydia.example/d', accountId: 'vendor-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await startLydiaOnboarding('asso-1', profile);
    const [, init] = apiFetchMock.mock.calls[0] as [string, { deadlineMs?: number }];
    expect(init.deadlineMs).toBe(LYDIA_ONBOARDING_DEADLINE_MS);
    expect(LYDIA_ONBOARDING_DEADLINE_MS).toBeGreaterThan(60_000);
  });

  it('a code-less 504 from nginx is an UNKNOWN outcome, not a save error', async () => {
    apiFetchMock.mockResolvedValue(
      new Response('<html>504 Gateway Time-out</html>', { status: 504 })
    );
    const err = await startLydiaOnboarding('asso-1', profile).catch((e: unknown) => e);
    expect(lydiaOnboardingOutcomeUnknown(err)).toBe(true);
  });
});
