import { describe, expect, it, vi } from 'vitest';
import { createFormSummaryBatcher, FORM_SUMMARIES_MAX, type FormSummary } from './formSummaries';

const row = (id: string): FormSummary => ({ id, title: `t-${id}`, hasSubmitted: false });

describe('createFormSummaryBatcher', () => {
  it('collapses every form asked in one turn into ONE request', async () => {
    const fetcher = vi.fn(async (ids: string[]) => ids.map(row));
    const summaryOf = createFormSummaryBatcher(fetcher);
    const got = await Promise.all(['a', 'b', 'c'].map(summaryOf));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(['a', 'b', 'c']);
    expect(got.map((g) => g?.id)).toEqual(['a', 'b', 'c']);
  });

  it('shares one answer between two cards asking for the same form in flight', async () => {
    const fetcher = vi.fn(async (ids: string[]) => ids.map(row));
    const summaryOf = createFormSummaryBatcher(fetcher);
    await Promise.all([summaryOf('a'), summaryOf('a')]);
    expect(fetcher).toHaveBeenCalledWith(['a']);
  });

  it('does not keep a settled answer: a later card asks again', async () => {
    const fetcher = vi.fn(async (ids: string[]) => ids.map(row));
    const summaryOf = createFormSummaryBatcher(fetcher);
    await summaryOf('a');
    await summaryOf('a');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('resolves null for a form the server left out, and REJECTS when nothing answered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const summaryOf = createFormSummaryBatcher(async (ids) =>
      ids.filter((i) => i !== 'gone').map(row)
    );
    await expect(summaryOf('gone')).resolves.toBeNull();
    const failing = createFormSummaryBatcher(async () => {
      throw new Error('timeout');
    });
    await expect(failing('a')).rejects.toThrow('timeout');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('splits a page beyond the server cap into several requests', async () => {
    const fetcher = vi.fn(async (ids: string[]) => ids.map(row));
    const summaryOf = createFormSummaryBatcher(fetcher);
    const ids = Array.from({ length: FORM_SUMMARIES_MAX + 1 }, (_, i) => `f${i}`);
    await Promise.all(ids.map(summaryOf));
    expect(fetcher.mock.calls.map((c) => c[0].length)).toEqual([FORM_SUMMARIES_MAX, 1]);
  });
});
