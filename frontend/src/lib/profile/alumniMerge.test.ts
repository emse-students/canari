/**
 * The Alumni merge client (D48): "Rattacher" marks, "Annuler" removes the mark, and every refusal
 * is read from the `code` of the body, never from its prose.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://core.test' }));

import { m } from '$lib/paraglide/messages';
import {
  ALUMNI_MERGE_REASON_MAX,
  ALUMNI_MERGE_REASON_MIN,
  alumniMergeErrorMessage,
  alumniReasonState,
  alumniSiteLine,
  cancelAlumniMerge,
  fetchAlumniClosedMerges,
  fetchAlumniMergeTargets,
  fetchAlumniOpenMerges,
  mergeAlumniDuplicate,
} from './alumniMerge';

const answer = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

/** The reason bounds both sides assert, and the cases that tell code points from UTF-16 units. */
const REASON_CONTRACT = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'alumni-merge-reason.json'),
    'utf8'
  )
) as {
  min: number;
  max: number;
  cases: { text: string; length: number; problem: 'too_short' | 'too_long' | null }[];
};

const DUP = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

beforeEach(() => apiFetch.mockReset());

/** The refusal a call throws, read as the admin reads it. */
async function said(call: Promise<unknown>): Promise<string> {
  return call.then(
    () => 'resolved',
    (err: unknown) => alumniMergeErrorMessage(err)
  );
}

describe('the Alumni merge client', () => {
  it('marks with the target in the body', async () => {
    apiFetch.mockResolvedValue(answer(200, { status: 'marked', held: {} }));
    await mergeAlumniDuplicate(DUP, TARGET);
    expect(apiFetch).toHaveBeenCalledWith(
      `https://core.test/api/users/admin/alumni-duplicates/${DUP}/merge`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ targetUuid: TARGET }) })
    );
  });

  it('a manual merge carries its reason (D55)', async () => {
    apiFetch.mockResolvedValue(answer(200, { status: 'marked', held: {}, mode: 'manual' }));
    await mergeAlumniDuplicate(DUP, TARGET, 'Same person: married name, confirmed.');
    expect(apiFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          targetUuid: TARGET,
          reason: 'Same person: married name, confirmed.',
        }),
      })
    );
  });

  it('searches the eligible targets with the query encoded', async () => {
    apiFetch.mockResolvedValue(answer(200, []));
    expect(await fetchAlumniMergeTargets(DUP, 'Camille M&')).toEqual([]);
    expect(apiFetch).toHaveBeenCalledWith(
      `https://core.test/api/users/admin/alumni-duplicates/${DUP}/targets?q=Camille%20M%26`
    );
  });

  it('lists the closed merges', async () => {
    apiFetch.mockResolvedValue(answer(200, []));
    await fetchAlumniClosedMerges();
    expect(apiFetch).toHaveBeenCalledWith('https://core.test/api/users/admin/alumni-merges/closed');
  });

  it.each([
    ['', 0, false, 'too_short'],
    [`  ${'y'.repeat(19)}  `, 19, false, 'too_short'],
    ['x'.repeat(20), 20, true, null],
    [`  ${'x'.repeat(1000)}  `, 1000, true, null],
    ['x'.repeat(1001), 1001, false, 'too_long'],
  ])('reads a reason against the server bounds (%#)', (text, length, valid, problem) => {
    expect(alumniReasonState(text)).toEqual({ length, valid, problem });
  });

  it.each(REASON_CONTRACT.cases)(
    'counts %j in code points, as the server does (libs/contracts/alumni-merge-reason.json)',
    ({ text, length, problem }) => {
      expect(alumniReasonState(text)).toEqual({ length, valid: problem === null, problem });
    }
  );

  it('holds the contract bounds, and counts an emoji once at the upper one', () => {
    expect([ALUMNI_MERGE_REASON_MIN, ALUMNI_MERGE_REASON_MAX]).toEqual([
      REASON_CONTRACT.min,
      REASON_CONTRACT.max,
    ]);
    expect(alumniReasonState('😀'.repeat(REASON_CONTRACT.max)).valid).toBe(true);
    expect(alumniReasonState('😀'.repeat(REASON_CONTRACT.max + 1)).problem).toBe('too_long');
  });

  it.each([
    [
      'done',
      { outcome: 'transferred' },
      m.admin_alumni_site_done({ site: 'sky', outcome: m.admin_alumni_site_outcome_transferred() }),
    ],
    [
      'blocked',
      { lastError: 'HTTP 409 X' },
      m.admin_alumni_site_blocked({ site: 'sky', error: 'HTTP 409 X' }),
    ],
    ['unready', {}, m.admin_alumni_site_unready({ site: 'sky' })],
    ['pending', { attempts: 2 }, m.admin_alumni_site_pending({ site: 'sky', attempts: 2 })],
  ] as const)('says a %s site job as the admin reads it', (state, over, said) => {
    expect(
      alumniSiteLine({ site: 'sky', state, outcome: null, attempts: 0, lastError: null, ...over })
    ).toBe(said);
  });

  it('cancels by POST on the duplicate', async () => {
    apiFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await cancelAlumniMerge(DUP);
    expect(apiFetch).toHaveBeenCalledWith(
      `https://core.test/api/users/admin/alumni-duplicates/${DUP}/cancel`,
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('lists the open merges', async () => {
    const open = [{ duplicateUuid: DUP, targetUuid: TARGET, status: 'marked' }];
    apiFetch.mockResolvedValue(answer(200, open));
    expect(await fetchAlumniOpenMerges()).toEqual(open);
    expect(apiFetch).toHaveBeenCalledWith('https://core.test/api/users/admin/alumni-merges');
  });

  it.each([
    ['ALUMNI_MERGE_IN_PROGRESS', () => m.alumni_merge_error_in_progress()],
    ['ALUMNI_MERGE_ALREADY_MERGED', () => m.alumni_merge_error_already_merged()],
    ['ALUMNI_MERGE_NO_MATCH', () => m.alumni_merge_error_no_match()],
    ['ALUMNI_MERGE_TARGET_BUSY', () => m.alumni_merge_error_target_busy()],
    [
      'ALUMNI_MERGE_REASON_REQUIRED',
      () => m.alumni_merge_error_reason_required({ min: 20, max: 1000 }),
    ],
  ])('words the refusal %s by its code', async (code, expected) => {
    apiFetch.mockResolvedValue(answer(409, { code, message: 'prose nobody reads' }));
    expect(await said(cancelAlumniMerge(DUP))).toBe(expected());
  });
});
