// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import type { FormResults } from '$lib/forms/api';

const getFormResults = vi.hoisted(() => vi.fn());
vi.mock('$lib/forms/api', async (original) => ({
  ...(await original<typeof import('$lib/forms/api')>()),
  getFormResults,
}));

import FormResultsSummary from './FormResultsSummary.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  getFormResults.mockReset();
});

function render(onShowTable = vi.fn()): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(FormResultsSummary, { target, props: { formId: 'f1', onShowTable } });
  mounted.push(() => void unmount(component));
  return target;
}

const results = (over: Partial<FormResults>): FormResults => ({
  totalAnswers: 12,
  anonymous: false,
  minAnswers: null,
  questions: [],
  ...over,
});

describe('FormResultsSummary', () => {
  it('draws a scale as its distribution and its mean, the denominator in words', async () => {
    getFormResults.mockResolvedValue(
      results({
        questions: [
          {
            id: 's1',
            label: 'Mood',
            kind: 'scale',
            suppressed: false,
            answered: 4,
            min: 1,
            max: 3,
            distribution: [
              { value: 1, count: 0 },
              { value: 2, count: 1 },
              { value: 3, count: 3 },
            ],
            mean: 2.75,
          },
        ],
      })
    );
    const target = render();
    await vi.waitFor(() =>
      expect(target.querySelector('[data-testid="result-scale"]')).toBeTruthy()
    );
    expect(target.querySelector('[data-testid="scale-mean"]')!.textContent).toContain(
      m.form_responses_summary_answers({ count: 4 })
    );
    const steps = [...target.querySelectorAll('[data-testid="result-scale"] li')].map((li) =>
      li.textContent!.replace(/\s+/g, ' ').trim()
    );
    expect(steps).toEqual(['1 0 · 0 %', '2 1 · 25 %', '3 3 · 75 %']);
  });

  it("says why an anonymous form's thin question has no figure, and draws none", async () => {
    getFormResults.mockResolvedValue(
      results({
        anonymous: true,
        minAnswers: 5,
        questions: [{ id: 'c1', label: 'Colour', kind: 'choice', suppressed: true }],
      })
    );
    const target = render();
    await vi.waitFor(() =>
      expect(target.querySelector('[data-testid="result-suppressed"]')).toBeTruthy()
    );
    expect(target.querySelector('[data-testid="result-suppressed"]')!.textContent).toContain(
      m.form_results_suppressed({ min: 5 })
    );
    expect(target.querySelector('[data-testid="results-anonymous"]')).toBeTruthy();
    expect(target.querySelectorAll('li')).toHaveLength(0);
  });

  it('gives a text question its count and a way to the table, nothing more', async () => {
    getFormResults.mockResolvedValue(
      results({
        questions: [{ id: 't1', label: 'Why', kind: 'text', suppressed: false, answered: 9 }],
      })
    );
    const onShowTable = vi.fn();
    const target = render(onShowTable);
    await vi.waitFor(() =>
      expect(target.querySelector('[data-testid="text-answered"]')).toBeTruthy()
    );
    expect(target.querySelector('[data-testid="text-answered"]')!.textContent).toContain(
      m.form_responses_summary_answers({ count: 9 })
    );
    target.querySelector<HTMLButtonElement>('section button')!.click();
    expect(onShowTable).toHaveBeenCalledOnce();
  });

  it('counts a multiple choice by tick and shows an unlisted pick as its own line', async () => {
    getFormResults.mockResolvedValue(
      results({
        questions: [
          {
            id: 'm1',
            label: 'Days',
            kind: 'choice',
            suppressed: false,
            multiple: true,
            answered: 4,
            options: [
              { id: 'd1', label: 'Mon', count: 4 },
              { id: 'd2', label: 'Tue', count: 3 },
            ],
            unlisted: 1,
          },
        ],
      })
    );
    const target = render();
    await vi.waitFor(() =>
      expect(target.querySelector('[data-testid="result-choice"]')).toBeTruthy()
    );
    const lines = [...target.querySelectorAll('li')].map((li) =>
      li.textContent!.replace(/\s+/g, ' ').trim()
    );
    expect(lines).toEqual([
      'Mon 4 · 100 %',
      'Tue 3 · 75 %',
      `${m.form_results_unlisted()} 1 · 25 %`,
    ]);
    expect(target.textContent).toContain(
      m.form_results_denominator_multiple({
        answers: m.form_responses_summary_answers({ count: 4 }),
      })
    );
  });

  it('says it failed, and reads again on retry', async () => {
    getFormResults.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(results({}));
    const target = render();
    await vi.waitFor(() =>
      expect(target.querySelector('[data-testid="results-error"]')).toBeTruthy()
    );
    target.querySelector<HTMLButtonElement>('[data-testid="results-error"] button')!.click();
    await vi.waitFor(() =>
      expect(target.querySelector('[data-testid="results-total"]')).toBeTruthy()
    );
    expect(getFormResults).toHaveBeenCalledTimes(2);
  });
});
