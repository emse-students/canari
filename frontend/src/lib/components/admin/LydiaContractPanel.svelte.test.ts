// @vitest-environment happy-dom
/**
 * THE LYDIA CONTRACT PANEL ON /admin/platform: what is not entered is SAID to be not configured
 * (never a default), the counter shows the flux against the target and the band, and a save sends
 * the whole set in cents and basis points. Every number here is made up for the test.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://core.test' }));

import Panel from './LydiaContractPanel.svelte';
import { m } from '$lib/paraglide/messages';

const EMPTY = {
  anniversary: '2031-03-05',
  fluxTargetCents: null,
  vatBps: null,
  fees: {},
  bands: [],
};

const COUNTER_UNSET = {
  today: '2031-06-01',
  year: { start: '2031-03-05', end: '2032-03-05', daysTotal: 366, daysLeft: 278 },
  flux: {
    paidCents: 0,
    paymentCount: 0,
    refundedCents: 0,
    refundCount: 0,
    fluxCents: 0,
    excludedCents: 0,
    excludedCount: 0,
    untraceableCents: 0,
    untraceableCount: 0,
    byAssociation: [] as unknown[],
  },
  targetCents: null,
  band: null,
  nextBand: null,
  missing: ['target', 'bands'],
};

const mounted: (() => void)[] = [];

function route(settings: unknown, counter: unknown) {
  apiFetch.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'PUT') {
      return Promise.resolve(new Response(init.body ?? '{}', { status: 200 }));
    }
    if (url.endsWith('/counter')) {
      return Promise.resolve(new Response(JSON.stringify(counter), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify(settings), { status: 200 }));
  });
}

const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    flushSync();
    await tick();
  }
};

async function render() {
  const app = mount(Panel, { target: document.body });
  mounted.push(() => unmount(app));
  await settle();
}

function type(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  apiFetch.mockReset();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('LydiaContractPanel', () => {
  it('names what is not configured, and draws no progress without a target', async () => {
    route(EMPTY, COUNTER_UNSET);
    await render();

    expect(document.body.textContent).toContain(
      m.admin_lydia_counter_not_configured({
        fields: `${m.admin_lydia_field_target()}, ${m.admin_lydia_field_bands()}`,
      })
    );
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('shows the flux against the target, the band reached and the next one', async () => {
    route(EMPTY, {
      ...COUNTER_UNSET,
      flux: { ...COUNTER_UNSET.flux, paidCents: 30_000, fluxCents: 25_000, refundedCents: 5_000 },
      targetCents: 100_000,
      band: { index: 0, fromCents: 0, fees: {} },
      nextBand: { index: 1, fromCents: 40_000, fees: {} },
      missing: [],
    });
    await render();

    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(
      '25'
    );
    expect(document.body.textContent).toContain(m.admin_lydia_counter_in_person_note());
    expect(document.body.textContent).toMatch(/150,00/);
  });

  it('lists the part of the flux each association brings, its share, and what is not counted', async () => {
    const share = (over: Record<string, unknown>) => ({
      ...COUNTER_UNSET.flux,
      byAssociation: undefined,
      associationId: 'a',
      name: 'Alpha',
      type: 'association',
      ...over,
    });
    route(EMPTY, {
      ...COUNTER_UNSET,
      flux: {
        ...COUNTER_UNSET.flux,
        paidCents: 40_000,
        fluxCents: 40_000,
        excludedCents: 7_000,
        excludedCount: 1,
        byAssociation: [
          share({ associationId: 'a', name: 'Alpha', paidCents: 30_000, fluxCents: 30_000 }),
          share({
            associationId: 'b',
            name: 'Beta',
            type: 'list',
            paidCents: 10_000,
            fluxCents: 10_000,
          }),
          share({ associationId: 'c', name: 'Gamma', excludedCents: 7_000, excludedCount: 1 }),
        ],
      },
    });
    await render();

    const rows = [...document.querySelectorAll('[data-testid="lydia-flux-breakdown"] li')].map(
      (li) => li.textContent ?? ''
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('Alpha');
    expect(rows[0]).toContain('75');
    expect(rows[1]).toContain('Beta');
    expect(rows[1]).toContain(m.admin_lydia_breakdown_list());
    expect(rows[1]).toContain('25');
    expect(rows[2]).toContain('70,00');
  });

  it('saves the whole set in cents and basis points', async () => {
    route(EMPTY, COUNTER_UNSET);
    await render();
    type('#lydia-target', '1234,5');
    type('#lydia-vat', '12.5');
    await settle();
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();

    const put = apiFetch.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(put![1].body)).toEqual({
      anniversary: '2031-03-05',
      fluxTargetCents: 123_450,
      vatBps: 1_250,
      fees: {},
      bands: [],
    });
    const statuses = [...document.querySelectorAll('[role="status"]')].map((e) => e.textContent);
    expect(statuses).toContain(m.admin_lydia_saved());
  });
});
