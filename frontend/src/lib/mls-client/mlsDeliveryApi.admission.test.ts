import { describe, expect, it, vi } from 'vitest';
import {
  MemberNotAdmittedError,
  MlsDeliveryApi,
  ReviewCohortBoundaryError,
  UserBlockedError,
} from './mlsDeliveryApi';

/**
 * WHO ADMITS A NEW PERSON, AS THE CLIENT READS IT (ADM-3). The member-add call enrols nobody any
 * more: it answers `MEMBER_NOT_ADMITTED` for a person no accepted commit admitted, and the caller
 * withholds the Welcome - typed at the throw, never read from prose. And an invitation's roster is
 * read WITH the seat generation it is decided at, so the Add can carry it to the gate.
 */
const api = (res: Response) =>
  new MlsDeliveryApi({
    historyUrl: 'https://example.test',
    getToken: async () => 'token',
    fetchImpl: vi.fn().mockResolvedValue(res) as unknown as typeof fetch,
  });
const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('registerMember - the refusals a caller acts on', () => {
  it('throws MemberNotAdmittedError on MEMBER_NOT_ADMITTED', async () => {
    const e = await api(answer(409, { code: 'MEMBER_NOT_ADMITTED' }))
      .registerMember('g1', 'joe')
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MemberNotAdmittedError);
    expect((e as MemberNotAdmittedError).userId).toBe('joe');
  });

  it('still throws UserBlockedError on USER_BLOCKED', async () => {
    const e = await api(answer(403, { code: 'USER_BLOCKED' }))
      .registerMember('g1', 'joe')
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UserBlockedError);
  });

  it('throws ReviewCohortBoundaryError on REVIEW_COHORT_BOUNDARY, and logs nothing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const e = await api(answer(403, { code: 'REVIEW_COHORT_BOUNDARY' }))
      .registerMember('g1', 'joe')
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ReviewCohortBoundaryError);
    expect((e as ReviewCohortBoundaryError).userId).toBe('joe');
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('keeps its tolerance for any other refusal, and says so', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(api(answer(500, {})).registerMember('g1', 'joe')).resolves.toBeUndefined();
    expect(err.mock.calls[0][0]).toContain('status=500');
    err.mockRestore();
  });
});

describe('getGroupRosterAtGeneration', () => {
  it('reads the roster and the generation it was read at', async () => {
    const got = await api(
      answer(200, { seatGeneration: 4, members: [{ userId: 'alice', awaitingAdmission: false }] })
    ).getGroupRosterAtGeneration('g1');
    expect(got).toEqual({
      seatGeneration: 4,
      members: [{ userId: 'alice', awaitingAdmission: false }],
    });
  });

  it('knows no generation from a server that answers the bare list', async () => {
    // An older server ignores the query: the Add then carries none, and the gate orders by the epoch.
    const got = await api(answer(200, [{ userId: 'alice' }])).getGroupRosterAtGeneration('g1');
    expect(got).toEqual({ seatGeneration: null, members: [{ userId: 'alice' }] });
  });

  it('throws on an answer that is neither shape, rather than reading it as an empty roster', async () => {
    await expect(
      api(answer(200, { nope: true })).getGroupRosterAtGeneration('g1')
    ).rejects.toThrow();
  });
});
