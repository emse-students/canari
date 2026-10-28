import axios from 'axios';
import { readVerifiedRequestState } from './verified-request-state';

describe('readVerifiedRequestState', () => {
  afterEach(() => jest.restoreAllMocks());

  const answer = (data: unknown) => jest.spyOn(axios, 'post').mockResolvedValue({ data } as never);

  it('asks core to verify over the expected amount, and types its verdict', async () => {
    const post = answer({ ok: true, verification: 'verified', state: 'paid', raw: '1' });
    await expect(readVerifiedRequestState({ sessionId: 'u' }, 'vendor', 1200)).resolves.toEqual({
      verification: 'verified',
      state: 'paid',
      raw: '1',
    });
    expect(post).toHaveBeenCalledWith(
      expect.stringMatching(/payments\/request-state$/),
      { sessionId: 'u', connectAccountId: 'vendor', expectedAmountCents: 1200 },
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });

  it('reads no-key with no state: Lydia was not asked', async () => {
    answer({ ok: true, verification: 'no-key' });
    await expect(readVerifiedRequestState({ sessionId: 'u' }, 'v', 1)).resolves.toEqual({
      verification: 'no-key',
    });
  });

  it('reads a verdict it does not know - an older core answers none - as unknown, never verified', async () => {
    answer({ ok: true, state: 'paid', raw: '1' });
    await expect(readVerifiedRequestState({ sessionId: 'u' }, 'v', 1)).resolves.toMatchObject({
      verification: 'unknown',
      state: 'paid',
    });
  });

  it('keeps not-found, and reads a state it does not know as unknown', async () => {
    answer({ ok: true, verification: 'unsigned', state: 'not-found', raw: 'error 2' });
    await expect(readVerifiedRequestState({ orderRef: 'o' }, 'v', 1)).resolves.toMatchObject({
      state: 'not-found',
    });
    answer({ ok: true, verification: 'verified', state: 'closed', raw: '9' });
    await expect(readVerifiedRequestState({ sessionId: 'u' }, 'v', 1)).resolves.toMatchObject({
      state: 'unknown',
    });
  });

  const failWith = (status: number, data: unknown = {}) =>
    jest
      .spyOn(axios, 'post')
      .mockRejectedValue(
        Object.assign(new Error(`HTTP ${status}`), { response: { status, data } })
      );

  it("reads core's typed provider refusal as an ANSWER, with Lydia's code", async () => {
    failWith(400, { code: 'PAYMENT_PROVIDER_REFUSED', providerCode: '3', message: 'blocked' });
    await expect(readVerifiedRequestState({ sessionId: 'u' }, 'v', 1)).resolves.toEqual({
      verification: 'refused',
      providerCode: '3',
    });
  });

  it("reads core's own 400 for this request as a refusal too", async () => {
    failWith(400, { message: 'Invalid payload' });
    await expect(readVerifiedRequestState({ sessionId: 'u' }, 'v', 1)).resolves.toEqual({
      verification: 'refused',
      providerCode: 'core-400',
    });
  });

  it.each([503, 500, 401, 403])(
    'throws on HTTP %p: a fault or a refusal of THIS service, not a word about the request',
    async (status) => {
      failWith(status, { code: 'PAYMENT_PROVIDER_REFUSED' });
      await expect(readVerifiedRequestState({ sessionId: 'u' }, 'v', 1)).rejects.toThrow(
        `HTTP ${status}`
      );
    }
  );

  it('throws when core cannot be reached: not a verdict', async () => {
    jest.spyOn(axios, 'post').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(readVerifiedRequestState({ sessionId: 'u' }, 'v', 1)).rejects.toThrow(
      'ECONNREFUSED'
    );
  });
});
