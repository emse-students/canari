// @vitest-environment happy-dom
/**
 * THE RESPONSES SCREEN (WP-G4) AS A MANAGER READS IT: the payment filters keep the rows they name,
 * a guest's answer carries the "Invité" badge, and the "Totaux" tab counts cash not yet received
 * until the switch leaves it out - a refunded answer never.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import type { Form, Submission } from '$lib/forms/api';
import type { ProductGridLine } from '$lib/forms/productGridContract';
import { m } from '$lib/paraglide/messages';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';

vi.mock('$lib/associations/api', () => ({
  listAssociationPurchases: vi.fn(async () => []),
  listAssociationRefunds: vi.fn(async () => ({ standings: [], refunds: [] })),
}));
vi.mock('$lib/forms/api', async (original) => ({
  ...(await original<typeof import('$lib/forms/api')>()),
  validateCashSubmission: vi.fn(async () => ({ ok: true })),
  getFormResults: vi.fn(async () => ({
    totalAnswers: 3,
    anonymous: false,
    minAnswers: null,
    questions: [
      {
        id: 'place',
        label: 'Retrait',
        kind: 'choice',
        suppressed: false,
        multiple: false,
        answered: 3,
        options: [
          { id: 'local', label: 'Au local', count: 2 },
          { id: 'foyer', label: 'Au foyer', count: 1 },
        ],
        unlisted: 0,
      },
    ],
  })),
}));

import FormResponsesPanel from './FormResponsesPanel.svelte';

const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const GRID = {
  rows: [
    { id: 'vert', label: 'Vert' },
    { id: 'noir', label: 'Noir' },
  ],
  columns: [
    { id: 'm', label: 'M' },
    { id: 'l', label: 'L' },
  ],
  maxPerCell: 5,
  closedCells: ['noir:m'],
  pricing: { mode: 'single' as const, tiers: null, prices: { _all: { '*': 2800 } } },
};

const form: Form = {
  id: 'f1',
  title: 'Merch',
  items: [
    { id: 'grid', label: 'Sweat', required: true, type: 'product_grid', productGrid: GRID },
    {
      id: 'place',
      label: 'Retrait',
      required: true,
      type: 'single_choice',
      options: [
        { id: 'local', label: 'Au local', priceModifier: 0 },
        { id: 'foyer', label: 'Au foyer', priceModifier: 0 },
      ],
    },
  ],
  requiresPayment: true,
  createdAt: '2026-11-06T10:00:00.000Z',
  updatedAt: '2026-11-06T10:00:00.000Z',
} as Form;

const line = (rowId: string, colId: string, quantity: number): ProductGridLine => ({
  itemId: 'grid',
  itemLabel: 'Sweat',
  rowId,
  rowLabel: rowId === 'vert' ? 'Vert' : 'Noir',
  colId,
  colLabel: colId.toUpperCase(),
  quantity,
  unitCents: 2800,
  lineCents: 2800 * quantity,
  tierId: '_all',
  tierLabel: null,
});

const sub = (over: Partial<Submission>): Submission => ({
  id: 's',
  formId: 'f1',
  userId: 'u1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: null,
  answers: { place: 'local' },
  totalPaid: 2800,
  paymentStatus: 'paid',
  paymentMethod: 'online',
  createdAt: '2026-11-06T10:00:00.000Z',
  ...over,
});

const SUBMISSIONS: Submission[] = [
  sub({ id: 'paid', lines: [line('vert', 'm', 2)], totalPaid: 5600 }),
  sub({
    id: 'cash',
    userId: 'u2',
    firstName: 'Alan',
    lastName: 'Turing',
    paymentStatus: 'pending_cash',
    paymentMethod: 'cash',
    lines: [line('vert', 'l', 1)],
    answers: { place: 'foyer' },
  }),
  sub({
    id: 'refunded',
    userId: 'u3',
    firstName: 'Grace',
    lastName: 'Hopper',
    paymentStatus: 'refunded',
    lines: [line('noir', 'l', 4)],
    totalPaid: 11200,
  }),
  sub({
    id: 'guest',
    userId: null,
    firstName: null,
    lastName: null,
    reference: '1A2B-3C4D',
    lines: [line('noir', 'l', 1)],
  }),
];

function render(submissions = SUBMISSIONS) {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(FormResponsesPanel, {
    target,
    props: {
      form,
      submissions,
      deletingId: null,
      onDelete: () => {},
      onReload: async () => {},
    },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  return target;
}

/** The rows the table draws (the `sm`-and-up layout), by the name cell's text. */
function rowNames(target: HTMLElement): string[] {
  return [...target.querySelectorAll('table tbody tr')].map(
    (row) => row.querySelectorAll('td')[2]?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  );
}

function click(el: Element | null) {
  (el as HTMLElement).click();
  flushSync();
}

function openTab(target: HTMLElement, label: string) {
  click([...target.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.includes(label))!);
}

describe('the "Réponses" tab', () => {
  it('filters by payment, and counts each chip', () => {
    const target = render();
    expect(rowNames(target)).toHaveLength(4);
    expect(target.querySelector('[data-testid="filter-unpaid"]')!.textContent).toContain('1');

    click(target.querySelector('[data-testid="filter-unpaid"]'));
    expect(rowNames(target)).toEqual(['Alan Turing']);

    click(target.querySelector('[data-testid="filter-refunded"]'));
    expect(rowNames(target)).toEqual(['Grace Hopper']);

    click(target.querySelector('[data-testid="filter-paid"]'));
    expect(rowNames(target)).toHaveLength(2);
  });

  it('searches the names and the answers, accents folded', async () => {
    const target = render();
    const input = target.querySelector<HTMLInputElement>('[data-testid="responses-search"]')!;
    input.value = 'FOYER';
    input.dispatchEvent(new Event('input'));
    flushSync();
    expect(rowNames(target)).toEqual(['Alan Turing']);
    input.value = 'nobody';
    input.dispatchEvent(new Event('input'));
    flushSync();
    expect(target.querySelector('[data-testid="responses-no-match"]')).not.toBeNull();
  });

  it('marks a guest answer "Invité", and only that one', () => {
    const target = render();
    const badges = target.querySelectorAll('table [data-testid="guest-badge"]');
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe(m.form_submitter_guest());
    expect(rowNames(target)[3]).toContain('1A2B-3C4D');
  });

  // Owner, 2026-11-06: a guest who gave a name is shown under it in place of the reference, and
  // keeps the badge; the search finds the name too.
  it('names a guest by what they typed, beside the reference and the badge', () => {
    const named = SUBMISSIONS.map((s) =>
      s.id === 'guest' ? { ...s, guestFirstName: 'Marie', guestLastName: 'Curie' } : s
    );
    const target = render(named);
    expect(rowNames(target)[3]).toContain('Marie Curie');
    // Never the name alone: it would read as an account's (review of #3096).
    expect(rowNames(target)[3]).toContain('1A2B-3C4D');
    expect(target.querySelectorAll('table [data-testid="guest-badge"]')).toHaveLength(1);
    const input = target.querySelector<HTMLInputElement>('[data-testid="responses-search"]')!;
    input.value = 'curie';
    input.dispatchEvent(new Event('input'));
    flushSync();
    expect(rowNames(target)).toHaveLength(1);
  });

  it('offers "mark paid" on the cash answer only', () => {
    const target = render();
    expect(target.querySelectorAll('table [data-testid="mark-paid"]')).toHaveLength(1);
  });

  it('sums the cards: guests, unpaid cash to collect, collected, refunded', async () => {
    const target = render();
    await tick();
    const text = target.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain(m.form_responses_card_guests({ count: 1 }));
    // A plural, not "dont 1 d'invités": one guest reads in the singular.
    expect(text).toMatch(/dont 1 invité(?!s)|including 1 guest(?!s)/);
    expect(text).toMatch(/28,00\s?€ à encaisser|€28.00 to collect/);
    expect(text).toMatch(/112,00\s?€ remboursés|€112.00 refunded/);
  });
});

describe('the "Totaux" tab', () => {
  const cell = (target: HTMLElement, key: string) =>
    target.querySelector(`[data-testid="cell-${key}"]`)?.textContent;

  it('counts paid and unpaid cash, never a refunded answer', () => {
    const target = render();
    openTab(target, m.form_responses_tab_totals());
    expect(cell(target, 'vert:m')).toBe('2');
    expect(cell(target, 'vert:l')).toBe('1');
    // The guest's one Noir L; the refunded answer's four are not counted.
    expect(cell(target, 'noir:l')).toBe('1');
    expect(target.querySelector('[data-testid="grand-units"]')!.textContent).toContain(
      m.form_responses_units({ count: 4 })
    );
  });

  it('leaves unpaid cash out when the switch is off', () => {
    const target = render();
    openTab(target, m.form_responses_tab_totals());
    click(target.querySelector('input[type="checkbox"]'));
    expect(cell(target, 'vert:l')).toBe('0');
    expect(target.querySelector('[data-testid="grand-units"]')!.textContent).toContain(
      m.form_responses_units({ count: 3 })
    );
  });

  it('strikes a closed cell nobody ordered', () => {
    const target = render();
    openTab(target, m.form_responses_tab_totals());
    expect(cell(target, 'noir:m')).toBeUndefined();
    expect(target.querySelector('[data-testid="grid-totals"] .line-through')!.textContent).toBe(
      'M'
    );
  });
});

describe('the "Résumé" tab', () => {
  it('draws a bar per option from the server results, for managers only', async () => {
    const target = render();
    openTab(target, m.form_responses_tab_summary());
    await vi.waitFor(() =>
      expect(target.querySelector('[data-testid="result-choice"]')).toBeTruthy()
    );
    expect(target.textContent).toContain(m.form_responses_summary_managers_only());
    const result = target.querySelector('[data-testid="result-choice"]')!;
    const bars = [...result.querySelectorAll('li')].map((li) =>
      li.textContent!.replace(/\s+/g, ' ').trim()
    );
    expect(bars).toEqual(['Au local 2 · 67 %', 'Au foyer 1 · 33 %']);
    // The denominator is said on the card, in words.
    expect(result.textContent).toContain(
      m.form_results_denominator_single({ answers: m.form_responses_summary_answers({ count: 3 }) })
    );
    const api = await import('$lib/forms/api');
    expect(api.getFormResults).toHaveBeenCalledWith('f1');
  });
});

describe('refunds, through the association refund flow', () => {
  it('offers "Rembourser" on the paid answer whose payment is refundable', async () => {
    const associations = await import('$lib/associations/api');
    vi.mocked(associations.listAssociationPurchases).mockResolvedValueOnce([
      { id: 'p1', formId: 'f1', submissionId: 'paid' } as never,
    ]);
    vi.mocked(associations.listAssociationRefunds).mockResolvedValueOnce({
      standings: [
        {
          purchaseRecordId: 'p1',
          refundable: true,
          reason: null,
          withdrawal: 'form',
          paidCents: 5600,
          refundedCents: 0,
          openRefund: null,
        },
      ],
      refunds: [],
    });
    const target = document.body.appendChild(document.createElement('div'));
    const instance = mount(FormResponsesPanel, {
      target,
      props: {
        form: { ...form, associationId: 'a1' },
        submissions: SUBMISSIONS,
        deletingId: null,
        onDelete: () => {},
        onReload: async () => {},
      },
    });
    mounted.push(() => unmount(instance));
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelectorAll('table [data-testid="refund-open"]')).toHaveLength(1);
    });
  });
});

describe('a partial refund', () => {
  it('is taken off the amount collected and added to the refunded one, once', async () => {
    const associations = await import('$lib/associations/api');
    vi.mocked(associations.listAssociationPurchases).mockResolvedValueOnce([
      { id: 'p1', formId: 'f1', submissionId: 'paid' } as never,
    ]);
    vi.mocked(associations.listAssociationRefunds).mockResolvedValueOnce({
      standings: [
        {
          purchaseRecordId: 'p1',
          refundable: true,
          reason: null,
          withdrawal: 'form',
          paidCents: 5600,
          refundedCents: 1000,
          openRefund: null,
        },
      ],
      refunds: [],
    });
    const target = document.body.appendChild(document.createElement('div'));
    const instance = mount(FormResponsesPanel, {
      target,
      props: {
        form: { ...form, associationId: 'a1' },
        submissions: SUBMISSIONS,
        deletingId: null,
        onDelete: () => {},
        onReload: async () => {},
      },
    });
    mounted.push(() => unmount(instance));
    // Paid 56 + the guest's 28 = 84 received; 10 of it went back. The refunded answer's 112 is
    // not collected, and is refunded once.
    await vi.waitFor(() => {
      flushSync();
      const text = target.textContent!.replace(/\s+/g, ' ');
      expect(text).toMatch(/74,00\s?€|€74.00/);
      expect(text).toMatch(/122,00\s?€ remboursés|€122.00 refunded/);
    });
  });

  it('cannot be read by a manager the refunds refuse: the amount says it is gross', async () => {
    const associations = await import('$lib/associations/api');
    vi.mocked(associations.listAssociationRefunds).mockRejectedValueOnce(
      new ApiRefusalError(403, null, 'forbidden')
    );
    const target = document.body.appendChild(document.createElement('div'));
    const instance = mount(FormResponsesPanel, {
      target,
      props: {
        form: { ...form, associationId: 'a1' },
        submissions: SUBMISSIONS.filter((s) => s.paymentStatus !== 'refunded'),
        deletingId: null,
        onDelete: () => {},
        onReload: async () => {},
      },
    });
    mounted.push(() => unmount(instance));
    await tick();
    flushSync();
    expect(target.textContent).toContain(m.form_responses_card_collected_gross_hint());
  });
});

/**
 * WHO ANSWERED, AS THE FORM KEPT IT (owner, 2026-11-16): the promo and formation, status and campus
 * the form joins or asks are columns after the name, read from each answer's snapshot, with a
 * filter by promo, formation and status; a form that keeps none of them draws neither.
 */
describe('the respondent account fields in the responses list', () => {
  function renderWith(over: Partial<Form>, submissions: Submission[]) {
    const target = document.body.appendChild(document.createElement('div'));
    const instance = mount(FormResponsesPanel, {
      target,
      props: {
        form: { ...form, requiresPayment: false, ...over } as Form,
        submissions,
        deletingId: null,
        onDelete: () => {},
        onReload: async () => {},
      },
    });
    mounted.push(() => unmount(instance));
    flushSync();
    return target;
  }

  it('draws the joined fields as columns, from the snapshot, with the filters', () => {
    const target = renderWith({ respondentFields: ['lastName', 'firstName', 'cursus', 'campus'] }, [
      sub({
        id: 'a',
        respondentIdentity: {
          source: 'account',
          cursus: [{ promo: 2024, formation: 'ISMIN' }],
          campus: 'gardanne',
        },
      }),
    ]);
    expect(target.querySelector('[data-testid="identity-col-cursus"]')).not.toBeNull();
    expect(target.querySelector('[data-testid="identity-col-campus"]')).not.toBeNull();
    expect(target.querySelector('[data-testid="identity-col-status"]')).toBeNull();
    const cells = [...target.querySelectorAll('table tbody tr td')].map((td) =>
      td.textContent?.trim()
    );
    expect(cells).toContain('2024 ISMIN');
    expect(cells).toContain(m.profile_campus_gardanne());
    expect(target.querySelector('[data-testid="identity-filters"]')).not.toBeNull();
  });

  it('draws neither on a form that keeps none of them', () => {
    const target = renderWith({ respondentFields: ['lastName', 'firstName'] }, [sub({ id: 'a' })]);
    expect(target.querySelector('[data-testid^="identity-col-"]')).toBeNull();
    expect(target.querySelector('[data-testid="identity-filters"]')).toBeNull();
  });
});
