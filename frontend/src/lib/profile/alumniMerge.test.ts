/**
 * The Alumni merge client (D48): "Rattacher" marks, "Annuler" removes the mark, and every refusal
 * is read from the `code` of the body, never from its prose.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://core.test' }));

import { m } from '$lib/paraglide/messages';
import {
  alumniMergeErrorMessage,
  cancelAlumniMerge,
  fetchAlumniOpenMerges,
  mergeAlumniDuplicate,
} from './alumniMerge';

const answer = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

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
  ])('words the refusal %s by its code', async (code, expected) => {
    apiFetch.mockResolvedValue(answer(409, { code, message: 'prose nobody reads' }));
    expect(await said(cancelAlumniMerge(DUP))).toBe(expected());
  });
});
