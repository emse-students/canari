/**
 * THE FEE SCHEDULE IS ASKED ONCE PER READER, NOT ONCE PER ESTIMATE MOUNTED.
 *
 * A price screen mounts one estimate per price, and each asked core-service again - and, while no
 * schedule was entered, logged "not configured" again, on both sides. The answer is held
 * (`SharedCache`), the refusal to a reader who edits no price included, and dropped when an admin
 * saves the terms. A transport failure is never held. The schedule below is made up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://core.test' }));

const { fetchLydiaFeeSchedule, forgetLydiaFeeSchedule, LYDIA_FEES_NOT_A_PRICE_EDITOR } =
  await import('./lydiaFees');

const SCHEDULE = { percentBps: 300, fixedCents: 20, vatBps: 5_000 };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => {
  forgetLydiaFeeSchedule();
  apiFetch.mockReset();
});

describe('fetchLydiaFeeSchedule', () => {
  it('asks once for every estimate of the session, "not configured" included', async () => {
    apiFetch.mockImplementation(async () => json(200, { schedule: null }));
    expect(await Promise.all([fetchLydiaFeeSchedule(), fetchLydiaFeeSchedule()])).toEqual([
      null,
      null,
    ]);
    expect(await fetchLydiaFeeSchedule()).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('holds the refusal to a reader who edits no price as an answer', async () => {
    apiFetch.mockImplementation(async () =>
      json(403, { statusCode: 403, code: LYDIA_FEES_NOT_A_PRICE_EDITOR, message: 'no' })
    );
    expect(await fetchLydiaFeeSchedule()).toBe('not-a-price-editor');
    expect(await fetchLydiaFeeSchedule()).toBe('not-a-price-editor');
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('never holds a failure, and asks again after an admin saved the terms', async () => {
    apiFetch.mockImplementationOnce(async () => json(502, { code: 'LYDIA_FEES_CHECK_UNREADABLE' }));
    await expect(fetchLydiaFeeSchedule()).rejects.toBeDefined();
    apiFetch.mockImplementation(async () => json(200, { schedule: SCHEDULE }));
    expect(await fetchLydiaFeeSchedule()).toEqual(SCHEDULE);
    forgetLydiaFeeSchedule();
    expect(await fetchLydiaFeeSchedule()).toEqual(SCHEDULE);
    expect(apiFetch).toHaveBeenCalledTimes(3);
  });
});
