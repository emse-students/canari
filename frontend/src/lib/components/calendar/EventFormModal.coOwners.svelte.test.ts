/**
 * THE EVENT FORM LETS A USER NAME MORE THAN ONE CO-ORGANISER, DRIVEN THROUGH THE PICKER.
 *
 * "Can the interface really add more than one association?" was answered by reading the code (no
 * cap) and never by using it. This opens the real form, picks associations through the typeahead
 * exactly as a pointer does (focus, type, press an option), and asserts the payload that
 * `toCreatePayload` would send. A pick after the first must neither disable the field nor hide the
 * next candidates - until the cap of four organising associations (the owner plus three picks,
 * decided 2026-10-10), where the picker stops offering and says why.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const directory = vi.hoisted(() => [] as { id: string; name: string; type: string }[]);

vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  listAssociations: async () => directory,
}));

import { setLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import EventFormModal from './EventFormModal.svelte';
import { blankEventFormValues, toCreatePayload } from '$lib/calendar/eventForm';

const mounted: ReturnType<typeof mount>[] = [];

beforeEach(() => {
  setLocale('en', { reload: false });
  directory.length = 0;
  for (const [i, name] of [
    'BDE',
    'BDA',
    'BDS',
    'Junior Entreprise',
    'Cine Club',
    'Robotique',
  ].entries()) {
    directory.push({ id: `a${i}`, name, type: 'association' });
  }
});
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

const tick = () => new Promise((r) => setTimeout(r, 0));

function search(): HTMLInputElement {
  return document.querySelector(
    `input[placeholder="${m.asso_calendar_co_owner_search_placeholder()}"]`
  ) as HTMLInputElement;
}

/** Focus, optionally type, then press the option the way the picker listens (mousedown). */
async function pick(name: string, typed = '') {
  const input = search();
  input.dispatchEvent(new FocusEvent('focus'));
  input.value = typed;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  const option = [...document.querySelectorAll('ul button')].find(
    (b) => b.textContent?.trim() === name
  );
  if (!option) throw new Error(`option ${name} not offered`);
  option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  flushSync();
  await tick();
}

async function open(values: ReturnType<typeof blankEventFormValues>, onSubmit = async () => {}) {
  mounted.push(
    mount(EventFormModal, {
      target: document.body,
      props: {
        open: true,
        heading: 'h',
        values,
        capabilities: {},
        submitLabel: 'go',
        savingLabel: 'saving',
        onSubmit,
        onClose: () => {},
      },
    })
  );
  flushSync();
  await tick();
  flushSync();
}

describe('event form co-organisers', () => {
  it('adds a 2nd, 3rd and 4th association in total and submits all of them', async () => {
    const values = $state({ ...blankEventFormValues(), title: 'Gala', targetAssociationId: 'a5' });
    const submitted: string[][] = [];
    await open(values, async () => {
      submitted.push(toCreatePayload(values, {}).coOwnerIds ?? []);
    });

    await pick('BDE');
    expect(search().disabled).toBe(false);
    await pick('BDA', 'bd'); // typeahead path
    await pick('BDS');
    expect(values.coOwnerIds).toEqual(['a0', 'a1', 'a2']);
    expect(document.querySelectorAll('[data-co-owner-status="new"]').length).toBe(3);

    const go = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'go'
    )!;
    go.click();
    await tick();
    expect(submitted).toEqual([['a0', 'a1', 'a2']]);
  });

  it('counts organisers out of four and stops offering associations at the cap', async () => {
    const values = $state({ ...blankEventFormValues(), title: 'Gala', targetAssociationId: 'a5' });
    await open(values);
    const counter = () => document.querySelector('[data-co-owner-counter]')?.textContent?.trim();

    expect(counter()).toBe(m.asso_calendar_co_owner_counter({ count: 1, max: 4 }));
    await pick('BDE');
    await pick('BDA');
    await pick('BDS');
    expect(counter()).toBe(m.asso_calendar_co_owner_counter({ count: 4, max: 4 }));
    expect(document.body.textContent).toContain(m.asso_calendar_co_owner_cap_reached({ max: 4 }));

    search().dispatchEvent(new FocusEvent('focus'));
    flushSync();
    expect(document.querySelectorAll('ul button')).toHaveLength(0);
    expect(values.coOwnerIds).toHaveLength(3);
  });

  it('never offers the owner itself and a picked one leaves the list', async () => {
    const values = $state({ ...blankEventFormValues(), title: 'x', targetAssociationId: 'a5' });
    await open(values);
    search().dispatchEvent(new FocusEvent('focus'));
    flushSync();
    const names = () =>
      [...document.querySelectorAll('ul button')].map((b) => b.textContent?.trim());
    expect(names()).not.toContain('Robotique');
    expect(names()).toHaveLength(5);
    await pick('BDE');
    search().dispatchEvent(new FocusEvent('focus'));
    flushSync();
    expect(names()).not.toContain('BDE');
    expect(names()).toHaveLength(4);
    expect(names()).not.toContain('Robotique');
  });
});
