// @vitest-environment happy-dom
/**
 * THE REACH PICKER WHEN ITS OPTIONS CANNOT BE DRAWN (review of #3314): a failed load offers a Retry
 * that loads again, and options on a campus this build does not know are not drawn - accused by a
 * WARN and, when nothing is left, told to the author rather than shown as an empty block.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import InstitutionReachPicker from './InstitutionReachPicker.svelte';
import { m } from '$lib/paraglide/messages';
import { emptyReachDraft } from '$lib/posts/institutionReach';

const getInstitutionReachOptions = vi.hoisted(() =>
  vi.fn((_id: string): Promise<{ spaces: { formation: string; campus: string }[] }> =>
    Promise.resolve({ spaces: [] })
  )
);
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  getInstitutionReachOptions,
}));

const mounted: Record<string, unknown>[] = [];

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  getInstitutionReachOptions.mockReset();
  vi.restoreAllMocks();
});

async function settle() {
  for (let i = 0; i < 6; i++) await tick();
  flushSync();
}

async function open() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(InstitutionReachPicker, {
      target,
      props: { reach: emptyReachDraft(), associationId: 'inst-1', associationName: 'Mines' },
    })
  );
  await settle();
  return target;
}

describe('InstitutionReachPicker - options it cannot draw', () => {
  it('a failed load offers a Retry, which loads the options again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getInstitutionReachOptions.mockRejectedValueOnce(new Error('down'));
    getInstitutionReachOptions.mockResolvedValueOnce({
      spaces: [{ formation: 'ICM', campus: 'saint-etienne' }],
    });
    const target = await open();
    expect(target.textContent).toContain(m.post_reach_load_error({ name: 'Mines' }));
    target.querySelector<HTMLButtonElement>('[data-reach-retry]')!.click();
    await settle();
    expect(getInstitutionReachOptions).toHaveBeenCalledTimes(2);
    expect(target.querySelector('[data-reach-space="ICM|saint-etienne"]')).not.toBeNull();
    expect(target.querySelector('[data-reach-retry]')).toBeNull();
  });

  it('a campus this build does not know is not drawn, accused, and told when nothing is left', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getInstitutionReachOptions.mockResolvedValue({
      spaces: [{ formation: 'ICM', campus: 'mars' }],
    });
    const target = await open();
    expect(target.querySelector('[data-reach-space]')).toBeNull();
    expect(target.textContent).toContain(m.post_reach_unknown_campus({ name: 'Mines' }));
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[INSTITUTION_REACH]'))).toBe(true);
  });
});
