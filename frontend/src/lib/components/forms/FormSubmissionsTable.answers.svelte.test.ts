/**
 * THE RESPONSES TABLE ACTUALLY SHOWS THE ANSWERS, WHICH IS THE ONE THING READING IT CANNOT PROVE.
 *
 * `submissionTable.ts` decides which questions become columns and `answerText.ts` reads a stored
 * value; both have their own unit tests and both can be perfectly right while the screen shows
 * nothing. What is asserted here is the rendering between them: that a chosen column arrives as a
 * header AND a cell, that a question no column could hold is reachable in the panel, that the panel
 * is shut until somebody opens it, and that the row spanning the table spans ALL of it.
 *
 * THE COLSPAN IS THE CASE THAT CANNOT BE SEEN BY READING EITHER FILE. It is a number written beside
 * a list of columns built somewhere else, so it is correct exactly until a column is added to the
 * header and not to it - and a short colspan does not throw, it silently leaves the panel ending
 * mid-table. It is the arithmetic here that ties the two together.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { FormItem, Submission } from '$lib/forms/api';
import FormSubmissionsTable from './FormSubmissionsTable.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const item = (over: Partial<FormItem> = {}): FormItem => ({
  id: 'q1',
  label: 'Question',
  required: false,
  type: 'short_text',
  ...over,
});

const submission = (over: Partial<Submission> = {}): Submission => ({
  id: 's1',
  formId: 'f1',
  userId: 'u1',
  firstName: 'Mael',
  lastName: 'DEJARDIN',
  email: null,
  answers: {},
  totalPaid: 0,
  paymentStatus: 'free',
  createdAt: new Date(2026, 8, 20, 15, 7).toISOString(),
  ...over,
});

function render(items: FormItem[], submissions: Submission[]) {
  const component = mount(FormSubmissionsTable, {
    target: document.body,
    props: { items, submissions, deletingId: null, onDelete: vi.fn() },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return document.body;
}

/** The table layout only exists from `sm` up; the cards below it are a second subtree. */
function table(): HTMLTableElement {
  const found = document.querySelector('table');
  if (!found) throw new Error('no table rendered');
  return found as HTMLTableElement;
}

/** Opens the first row's answer panel the way a reader does. */
function openFirstPanel() {
  const control = table().querySelector('tbody button') as HTMLButtonElement;
  control.click();
  flushSync();
}

const ASSO = item({
  id: 'asso',
  label: 'Ton asso ?',
  type: 'single_choice',
  options: [
    { id: 'o1', label: "Humani'Mines", priceModifier: 0 },
    { id: 'o2', label: 'BDS', priceModifier: 0 },
  ],
});
const WHY = item({ id: 'why', label: 'Pourquoi ?', type: 'long_text' });

describe('the responses table, rendered', () => {
  it('gives a short question its own column, header and cell', () => {
    render([ASSO], [submission({ answers: { asso: 'o1' } })]);

    const headers = [...table().querySelectorAll('thead th')].map((th) => th.textContent?.trim());
    expect(headers).toContain('Ton asso ?');
    // The cell holds the LABEL, never the stored option id.
    const row = table().querySelector('tbody tr')!.textContent ?? '';
    expect(row).toContain("Humani'Mines");
    expect(row).not.toContain('o1');
  });

  it('gives a paragraph no column, and still shows it in the panel', () => {
    render([WHY], [submission({ answers: { why: 'Parce que le projet porte sur le handicap' } })]);

    const headers = [...table().querySelectorAll('thead th')].map((th) => th.textContent?.trim());
    expect(headers).not.toContain('Pourquoi ?');

    expect(document.body.textContent).not.toContain('porte sur le handicap');
    openFirstPanel();
    expect(document.body.textContent).toContain('Parce que le projet porte sur le handicap');
  });

  it('shows a matrix answer as row/value pairs rather than as JSON', () => {
    const matrix = item({
      id: 'dispo',
      label: 'Disponibilites',
      type: 'matrix_single',
      rows: ['Lundi', 'Mardi'],
      options: [
        { id: 'y', label: 'Oui', priceModifier: 0 },
        { id: 'n', label: 'Non', priceModifier: 0 },
      ],
    });
    render([matrix], [submission({ answers: { dispo: { Lundi: 'y', Mardi: 'n' } } })]);
    openFirstPanel();

    expect(document.body.textContent).toContain('Lundi: Oui; Mardi: Non');
    expect(document.body.textContent).not.toContain('{');
  });

  // A form can have more questions than the table has room for; none of them may be lost.
  it('puts every question past the column cap into the panel', () => {
    const items = Array.from({ length: 5 }, (_, n) =>
      item({ id: `q${n}`, label: `Question ${n}`, type: 'short_text' })
    );
    const answers = Object.fromEntries(items.map((q, n) => [q.id, `Reponse ${n}`]));
    render(items, [submission({ answers })]);

    const headers = [...table().querySelectorAll('thead th')].map((th) => th.textContent?.trim());
    expect(headers).not.toContain('Question 4');

    openFirstPanel();
    expect(document.body.textContent).toContain('Reponse 4');
  });

  it('spans the whole table with the panel, however many columns the form added', () => {
    render([ASSO, WHY], [submission({ answers: { asso: 'o1', why: 'Un texte' } })]);
    openFirstPanel();

    const headerCount = table().querySelectorAll('thead th').length;
    const panelCell = table().querySelector('tbody td[colspan]') as HTMLTableCellElement;
    expect(panelCell.colSpan).toBe(headerCount);
  });

  it('keeps the panel shut until it is opened', () => {
    render([WHY], [submission({ answers: { why: 'Un texte' } })]);
    expect(table().querySelector('tbody td[colspan]')).toBeNull();
    openFirstPanel();
    expect(table().querySelector('tbody td[colspan]')).not.toBeNull();
  });

  it('refuses to open a response that answered nothing', () => {
    render([WHY], [submission({ answers: {} })]);
    const control = table().querySelector('tbody button') as HTMLButtonElement;
    expect(control.disabled).toBe(true);
  });

  // Below `sm` the same rows are cards, and they are a separate subtree - a change to one that
  // forgets the other is the drift this asserts against.
  it('renders the same response as a card for a phone', () => {
    render([ASSO], [submission({ answers: { asso: 'o2' } })]);
    const cards = document.querySelectorAll('ul.sm\\:hidden > li');
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain('Mael DEJARDIN');
  });
});
