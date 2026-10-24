/// <reference types="jest" />

import { ServiceUnavailableException } from '@nestjs/common';
import {
  askDepartureOutcome,
  distributionScopeOf,
  isEntitledToDistributionGroup,
} from './distribution-entitlement';

/**
 * THE KEY-GROUP JOIN GATE ASKS AND NEVER GUESSES (WP-KEYGROUP-JOIN-GATE): social-service answers
 * `true` or `false`, and every other outcome is a 503 - not a refusal, not an acceptance.
 */
describe('isEntitledToDistributionGroup', () => {
  const scope = { kind: 'workspace' as const, id: 'ws-1' };
  let previous: string | undefined;
  let fetchSpy: jest.SpyInstance;

  const answer = (status: number, body: unknown) =>
    fetchSpy.mockResolvedValue(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    );

  beforeEach(() => {
    previous = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = 'sekret';
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (previous === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previous;
  });

  it.each([true, false])('returns the answer social-service gives (%s)', async (entitled) => {
    answer(200, { entitled });

    await expect(isEntitledToDistributionGroup(scope, 'user-1', 't')).resolves.toBe(entitled);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/internal\/distribution-groups\/entitlement$/);
    expect(init.headers).toMatchObject({ 'x-internal-secret': 'sekret' });
    expect(JSON.parse(String(init.body))).toEqual({
      kind: 'workspace',
      scopeId: 'ws-1',
      userId: 'user-1',
    });
  });

  it.each([
    ['a non-2xx', () => answer(500, { entitled: true })],
    ['a refused secret', () => answer(403, {})],
    ['an answer with no boolean', () => answer(200, { entitled: 'yes' })],
    ['an unreadable body', () => answer(200, 'not json')],
    ['an unreachable service', () => fetchSpy.mockRejectedValue(new TypeError('fetch failed'))],
  ])('is a 503, never an answer, on %s', async (_name, arrange) => {
    arrange();

    await expect(isEntitledToDistributionGroup(scope, 'user-1', 't')).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });

  it('is a 503 without asking when the secret is unset', async () => {
    delete process.env.INTERNAL_SECRET;

    await expect(isEntitledToDistributionGroup(scope, 'user-1', 't')).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/** The drain asks for ONE departure's outcome, by its name, and believes only the two outcomes. */
describe('askDepartureOutcome', () => {
  let previous: string | undefined;
  let fetchSpy: jest.SpyInstance;

  const answer = (status: number, body: unknown) =>
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(body), { status }));

  beforeEach(() => {
    previous = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = 'sekret';
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (previous === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previous;
  });

  it.each(['departed', 'cancelled'] as const)('returns %s, naming the departure', async (o) => {
    answer(200, { outcome: o });

    await expect(askDepartureOutcome('g-1', 'user-1', 3, 't')).resolves.toBe(o);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/internal\/distribution-groups\/departure-outcome$/);
    expect(JSON.parse(String(init.body))).toEqual({
      groupId: 'g-1',
      userId: 'user-1',
      departure: 3,
    });
  });

  it.each([
    ['an unknown outcome', () => answer(200, { outcome: 'entitled' })],
    ['a non-2xx', () => answer(404, {})],
    ['an unreachable service', () => fetchSpy.mockRejectedValue(new TypeError('fetch failed'))],
  ])('is a 503, never an outcome, on %s', async (_name, arrange) => {
    arrange();

    await expect(askDepartureOutcome('g-1', 'user-1', 3, 't')).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });
});

describe('distributionScopeOf', () => {
  it('names a community, a private salon, or nothing for a conversation', () => {
    expect(distributionScopeOf({ distributionWorkspaceId: 'ws-1' })).toEqual({
      kind: 'workspace',
      id: 'ws-1',
    });
    expect(distributionScopeOf({ distributionChannelId: 'ch-1' })).toEqual({
      kind: 'channel',
      id: 'ch-1',
    });
    expect(distributionScopeOf({})).toBeNull();
    expect(distributionScopeOf(null)).toBeNull();
  });
});
