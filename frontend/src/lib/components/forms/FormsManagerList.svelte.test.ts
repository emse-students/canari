// @vitest-environment happy-dom
/**
 * THE FORMS-MANAGEMENT LIST, in both of its scopes (owner, 2026-11-13: `/forms` and an association's
 * "Formulaires" tab are ONE component). These tests carry what the two screens' own tests pinned -
 * the actions row, the share address, "Voir le formulaire", the `?responses=` link, a guest paying
 * cash, the draft marker, a card on a phone - plus a test of each scope.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const url = vi.hoisted(() => ({ value: new URL('https://canari.test/forms') }));
const api = vi.hoisted(() => ({
  getSubmissions: vi.fn(async () => []),
  getHeldAnswers: vi.fn(async () => ({ held: 0, batchSize: 5 })),
  deleteForm: vi.fn(async () => ({ ok: true })),
  setFormClosed: vi.fn(async (id: string, closed: boolean) => ({
    id,
    closedAt: closed ? '2026-11-16T10:00:00.000Z' : null,
    windowState: closed ? 'closed' : 'open',
  })),
  setFormClosingDate: vi.fn(async (id: string, closedAt: string) => ({
    id,
    closedAt,
    windowState: 'open',
  })),
  keepFormOpen: vi.fn(async (id: string) => ({ id, changed: true })),
  deleteSubmission: vi.fn(),
  listPendingCashSubmissions: vi.fn(async (): Promise<unknown[]> => []),
  validateCashSubmission: vi.fn(async () => ({ ok: true })),
  cancelCashSubmission: vi.fn(async () => ({ ok: true })),
  exportLabels: vi.fn(() => ({})),
  exportSubmissions: vi.fn(async () => new Blob(['x'])),
}));
const copy = vi.hoisted(() => ({ copyPublicShareLink: vi.fn(async () => ({ ok: true })) }));
const confirm = vi.hoisted(() => ({ showConfirm: vi.fn(async () => true) }));

vi.mock('$lib/forms/api', () => api);
vi.mock('$lib/utils/copyShareLink', () => copy);
vi.mock('$lib/utils/fileDownload', () => ({ downloadDecryptedFile: vi.fn(async () => {}) }));
vi.mock('$lib/stores/confirm.svelte', () => confirm);
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return url.value;
    },
    state: {},
  },
}));

import FormsManagerList from './FormsManagerList.svelte';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import type { Form } from '$lib/forms/api';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { dismissToast, toastStore } from '$lib/stores/toast.svelte';

// Never undone: a Svelte outro (the menu closing) creates its animation from a timer that fires
// after the last test, so an undo would leave it unadopted and its cancellation unhandled.
adoptTransitionAnimations();

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
  url.value = new URL('https://canari.test/forms');
});

function form(over: Record<string, unknown>): Form {
  return {
    id: 'f1',
    title: 'Gala',
    items: [],
    basePrice: 0,
    associationName: null,
    status: 'published',
    ...over,
  } as unknown as Form;
}

async function render(forms: Form[], props: Record<string, unknown> = {}) {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(FormsManagerList, {
    target,
    props: { load: async () => forms, createHref: '/forms/create', ...props },
  });
  mounted.push(() => unmount(instance));
  await vi.waitFor(() => expect(target.querySelector('[data-testid="form-row"]')).not.toBeNull());
  return target;
}

/** The "..." menu of a row, opened; its entries are portalled to the body. */
async function openMenu(target: HTMLElement, id: string) {
  target.querySelector<HTMLButtonElement>(`#form-${id} [data-testid="form-row-menu"]`)!.click();
  flushSync();
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="menu-list"]')).not.toBeNull()
  );
}
const entry = (key: string) =>
  document.querySelector<HTMLButtonElement>(`[data-menu-item="${key}"]`);
const menuClosed = () =>
  vi.waitFor(() => expect(document.querySelector('[data-testid="menu-list"]')).toBeNull());

describe('FormsManagerList - the row', () => {
  it('keeps the two main actions on the row WITH their words, and the rest in one menu', async () => {
    const target = await render([form({})]);
    const actions = target.querySelector('[data-testid="form-card-actions"]')!;
    expect(actions.children).toHaveLength(3);
    const edit = target.querySelector('[data-testid="form-edit-link"]')!;
    expect(edit.textContent).toContain(m.form_list_edit_button());
    expect(edit.getAttribute('href')).toBe('/forms/f1/edit');
    expect(target.querySelector('[data-testid="form-responses-toggle"]')!.textContent).toContain(
      m.form_list_responses_button()
    );
    expect(actions.className).not.toContain('flex-wrap');
    expect(target.querySelector('[data-testid="form-row-menu"]')!.getAttribute('aria-label')).toBe(
      m.form_row_more_actions()
    );
  });

  it('shows the description as plain text, without markdown markers', async () => {
    const target = await render([
      form({
        description: '**Ce formulaire est un recensement** de [la liste](https://example.test).',
      }),
    ]);
    const excerpt = target.querySelector('#form-f1 [data-testid="form-card-title"] p')!;
    expect(excerpt.textContent!.trim()).toBe('Ce formulaire est un recensement de la liste.');
  });

  // happy-dom lays nothing out, so the rule is pinned where it lives: the classes that decide it.
  it('gives the title the whole width, and puts the actions below it until the row is wide', async () => {
    const target = await render([form({ title: 'Billetterie du gala de fin d annee' })]);
    const card = target.querySelector('li')!;
    const header = target.querySelector('[data-testid="form-card-header"]')!;
    const title = target.querySelector('[data-testid="form-card-title"]')!;
    expect(card.classList).toContain('@container');
    expect(header.classList).toContain('flex-col');
    expect(header.classList).toContain('@md:flex-row');
    expect(title.classList).toContain('min-w-0');
    expect(title.classList).toContain('flex-1');
    expect([...title.classList].some((c) => /^min-w-[1-9]/.test(c))).toBe(false);
  });

  it('names the price, and that cash is taken', async () => {
    const target = await render([
      form({ basePrice: 2800, allowCashPayment: true }),
      form({ id: 'f2', title: 'Free' }),
    ]);
    expect(target.querySelector('#form-f1')!.textContent).toContain('28.00');
    expect(target.querySelector('#form-f1')!.textContent).toContain(m.asso_forms_cash_accepted());
    expect(target.querySelector('#form-f2')!.textContent).toContain(m.asso_forms_price_free());
  });

  it('warns on a paid row when the payment account cannot collect, and only then', async () => {
    const paid = form({ basePrice: 2800 });
    const warn = m.asso_forms_payments_not_configured_badge();
    expect((await render([paid], { paymentsReady: false })).textContent).toContain(warn);
    document.body.innerHTML = '';
    expect((await render([paid], { paymentsReady: true })).textContent).not.toContain(warn);
    document.body.innerHTML = '';
    expect((await render([paid])).textContent).not.toContain(warn);
  });
});

describe('FormsManagerList - the two scopes', () => {
  it('global: each row names its association, or says it is personal', async () => {
    const target = await render([form({ associationName: 'Club' }), form({ id: 'f2' })]);
    expect(target.querySelector('#form-f1')!.textContent).toContain(
      m.form_list_association_badge({ association: 'Club' })
    );
    expect(target.querySelector('#form-f2')!.textContent).toContain(m.form_list_personal_badge());
  });

  it('scoped: the association is implied, so no row names it or calls itself personal', async () => {
    const target = await render([form({ associationName: 'Club' }), form({ id: 'f2' })], {
      scoped: true,
    });
    const text = target.textContent!;
    expect(text).not.toContain(m.form_list_association_badge({ association: 'Club' }));
    expect(text).not.toContain(m.form_list_personal_badge());
  });

  it('reads the same draft and unpublished-changes states in both scopes', async () => {
    const rows = [
      form({ id: 'd', status: 'draft' }),
      form({ id: 'u', hasUnpublishedChanges: true }),
      form({ id: 'p' }),
    ];
    for (const scoped of [false, true]) {
      document.body.innerHTML = '';
      const target = await render(rows, { scoped });
      expect(target.querySelector('#form-d [data-testid="form-draft-badge"]')).not.toBeNull();
      expect(target.querySelector('#form-u [data-testid="form-unpublished-badge"]')).not.toBeNull();
      expect(target.querySelectorAll('[data-testid="form-draft-badge"]')).toHaveLength(1);
      expect(target.querySelectorAll('[data-testid="form-unpublished-badge"]')).toHaveLength(1);
    }
  });

  it('heads a row with the level the page asks for', async () => {
    const target = await render([form({})], { headingTag: 'h3' });
    expect(target.querySelector('#form-f1 h3')!.textContent).toContain('Gala');
  });

  it('empty: says so and offers to create, at the address it was given', async () => {
    const target = document.body.appendChild(document.createElement('div'));
    const instance = mount(FormsManagerList, {
      target,
      props: { load: async () => [], createHref: '/forms/create?association=a1' },
    });
    mounted.push(() => unmount(instance));
    await vi.waitFor(() =>
      expect(target.querySelector('[data-testid="forms-empty"]')).not.toBeNull()
    );
    expect(target.querySelector('a')!.getAttribute('href')).toBe('/forms/create?association=a1');
  });

  it('empty and scoped with no create address: draws no second create button', async () => {
    const target = document.body.appendChild(document.createElement('div'));
    const instance = mount(FormsManagerList, {
      target,
      props: { load: async () => [], scoped: true },
    });
    mounted.push(() => unmount(instance));
    await vi.waitFor(() =>
      expect(target.querySelector('[data-testid="forms-empty"]')).not.toBeNull()
    );
    expect(target.querySelector('a')).toBeNull();
  });

  it('a failed read says so instead of showing an empty list', async () => {
    const target = document.body.appendChild(document.createElement('div'));
    const instance = mount(FormsManagerList, {
      target,
      props: {
        load: async () => {
          throw new Error('boom');
        },
        createHref: '/forms/create',
      },
    });
    mounted.push(() => unmount(instance));
    await vi.waitFor(() =>
      expect(target.querySelector('[data-testid="forms-load-error"]')).not.toBeNull()
    );
    expect(target.querySelector('[data-testid="forms-empty"]')).toBeNull();
  });

  it('tells the page how many forms it holds, and one fewer after a delete', async () => {
    const onForms = vi.fn();
    const target = await render([form({}), form({ id: 'f2' })], { onForms });
    expect(onForms).toHaveBeenLastCalledWith(expect.arrayContaining([expect.anything()]));
    expect(onForms.mock.lastCall![0]).toHaveLength(2);
    await openMenu(target, 'f1');
    entry('delete')!.click();
    await vi.waitFor(() => expect(onForms.mock.lastCall![0]).toHaveLength(1));
  });
});

describe('FormsManagerList - the menu', () => {
  it('offers a published form the view, the link, the QR code, the export and the delete', async () => {
    const target = await render([form({})]);
    await openMenu(target, 'f1');
    for (const key of ['view', 'link', 'qr', 'export:xlsx', 'delete']) {
      expect(entry(key), key).not.toBeNull();
    }
    expect(entry('export:articles-csv')).toBeNull();
  });

  it('offers a draft no link and no QR code, which nobody could open', async () => {
    const target = await render([form({ status: 'draft' })]);
    await openMenu(target, 'f1');
    expect(entry('view')).not.toBeNull();
    expect(entry('link')).toBeNull();
    expect(entry('qr')).toBeNull();
  });

  it('copies the guest address of a public form and the member address of any other', async () => {
    const target = await render([
      form({ id: 'pub', isPublic: true }),
      form({ id: 'mem', isPublic: false }),
    ]);
    await openMenu(target, 'pub');
    entry('link')!.click();
    expect(copy.copyPublicShareLink).toHaveBeenCalledWith('/f/pub');
    await menuClosed();
    await openMenu(target, 'mem');
    entry('link')!.click();
    expect(copy.copyPublicShareLink).toHaveBeenCalledWith('/forms/mem');
  });

  it('opens the live page, or the preview of a draft, in a new tab with noopener', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const target = await render([
      form({ id: 'live' }),
      form({ id: 'draft', status: 'draft' }),
      form({ id: 'edited', hasUnpublishedChanges: true }),
    ]);
    const expected: Record<string, string> = {
      live: '/forms/live',
      draft: '/forms/draft?preview=1',
      edited: '/forms/edited?preview=1',
    };
    for (const id of Object.keys(expected)) {
      await openMenu(target, id);
      entry('view')!.click();
      expect(open).toHaveBeenLastCalledWith(expected[id], '_blank', 'noopener');
      await menuClosed();
    }
  });

  it('offers the two grid CSVs on a form with a priced grid, and asks for the format picked', async () => {
    const grid = { type: 'product_grid', id: 'g', label: 'Merch', productGrid: {} };
    const target = await render([form({ items: [grid] })]);
    await openMenu(target, 'f1');
    expect(entry('export:articles-csv')).not.toBeNull();
    entry('export:totals-csv')!.click();
    await vi.waitFor(() =>
      expect(api.exportSubmissions).toHaveBeenCalledWith('f1', {}, 'totals-csv')
    );
  });

  it('deletes after a confirmation, and the row goes', async () => {
    const target = await render([form({}), form({ id: 'f2', title: 'Other' })]);
    await openMenu(target, 'f1');
    entry('delete')!.click();
    await vi.waitFor(() => expect(api.deleteForm).toHaveBeenCalledWith('f1'));
    await vi.waitFor(() => expect(target.querySelector('#form-f1')).toBeNull());
    expect(target.querySelector('#form-f2')).not.toBeNull();
  });

  it('starts one confirmation for a delete selected twice, never two', async () => {
    let release: (v: boolean) => void = () => {};
    confirm.showConfirm.mockImplementationOnce(() => new Promise<boolean>((r) => (release = r)));
    const target = await render([form({})]);
    await openMenu(target, 'f1');
    entry('delete')!.click();
    await menuClosed();
    await openMenu(target, 'f1');
    entry('delete')!.click();
    expect(confirm.showConfirm).toHaveBeenCalledTimes(1);
    release(true);
    await vi.waitFor(() => expect(api.deleteForm).toHaveBeenCalledTimes(1));
  });

  it('shows an export in flight on the trigger and starts no second one', async () => {
    let finish: (b: Blob) => void = () => {};
    api.exportSubmissions.mockImplementationOnce(() => new Promise<Blob>((r) => (finish = r)));
    const target = await render([form({})]);
    await openMenu(target, 'f1');
    entry('export:xlsx')!.click();
    const trigger = target.querySelector<HTMLButtonElement>(
      '#form-f1 [data-testid="form-row-menu"]'
    )!;
    await vi.waitFor(() => expect(trigger.disabled).toBe(true));
    expect(api.exportSubmissions).toHaveBeenCalledTimes(1);
    finish(new Blob(['x']));
    await vi.waitFor(() => expect(trigger.disabled).toBe(false));
  });

  it('deletes nothing when the confirmation is refused', async () => {
    confirm.showConfirm.mockResolvedValueOnce(false);
    const target = await render([form({})]);
    await openMenu(target, 'f1');
    entry('delete')!.click();
    await vi.waitFor(() => expect(confirm.showConfirm).toHaveBeenCalled());
    expect(api.deleteForm).not.toHaveBeenCalled();
  });
});

describe('FormsManagerList - the responses', () => {
  const two = () => [form({ id: 'f1', title: 'Gala' }), form({ id: 'f2', title: 'Rallye' })];

  it("opens the named form's responses from a link, and only that form's", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    url.value = new URL('https://canari.test/forms?responses=f2');
    await render(two());
    await vi.waitFor(() => expect(api.getSubmissions).toHaveBeenCalledWith('f2'));
    expect(api.getSubmissions).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });

  it('opens nothing without the parameter', async () => {
    await render(two());
    expect(api.getSubmissions).not.toHaveBeenCalled();
  });

  it('says in the log that the named form is not on the list, and opens nothing', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    url.value = new URL('https://canari.test/forms?responses=gone');
    await render(two());
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith(expect.stringContaining('gone')));
    expect(api.getSubmissions).not.toHaveBeenCalled();
  });

  it('the Reponses button opens the accordion and loads the answers', async () => {
    const target = await render(two());
    const toggle = target.querySelector<HTMLButtonElement>(
      '#form-f1 [data-testid="form-responses-toggle"]'
    )!;
    toggle.click();
    await vi.waitFor(() => expect(api.getSubmissions).toHaveBeenCalledWith('f1'));
    await vi.waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'));
  });
});

describe('FormsManagerList - an anonymous form whose answers wait for their batch', () => {
  async function openResponses(f: Form) {
    const target = await render([f]);
    target
      .querySelector<HTMLButtonElement>(`#form-${f.id} [data-testid="form-responses-toggle"]`)!
      .click();
    await vi.waitFor(() => expect(api.getSubmissions).toHaveBeenCalledWith(f.id));
    return target;
  }

  it('says how many answers wait and why, read after the answers', async () => {
    api.getHeldAnswers.mockResolvedValueOnce({ held: 3, batchSize: 5 });
    const target = await openResponses(form({ anonymous: true }));
    await vi.waitFor(() =>
      expect(target.querySelector('[data-testid="responses-held"]')?.textContent?.trim()).toBe(
        m.form_responses_held_notice({ count: 3, size: 5 })
      )
    );
    // The answers' read releases a closed form's: the count is asked only after it.
    expect(api.getSubmissions.mock.invocationCallOrder[0]).toBeLessThan(
      api.getHeldAnswers.mock.invocationCallOrder[0]
    );
  });

  it('says nothing when none waits', async () => {
    const target = await openResponses(form({ anonymous: true }));
    await vi.waitFor(() => expect(api.getHeldAnswers).toHaveBeenCalledWith('f1'));
    expect(target.querySelector('[data-testid="responses-held"]')).toBeNull();
  });

  it('never asks about a named form, which holds nothing back', async () => {
    await openResponses(form({}));
    expect(api.getHeldAnswers).not.toHaveBeenCalled();
  });
});

describe('FormsManagerList - cash awaiting validation', () => {
  function pendingRow(over: Record<string, unknown>) {
    return {
      id: 'sub-1',
      formId: 'f1',
      userId: null,
      email: null,
      answers: {},
      totalPaid: 2700,
      paymentStatus: 'pending_cash',
      createdAt: '2026-11-07T10:00:00.000Z',
      ...over,
    };
  }
  const cashForm = () => form({ basePrice: 2800, allowCashPayment: true });

  it('names a guest with no name by the reference they were given', async () => {
    api.listPendingCashSubmissions.mockResolvedValueOnce([pendingRow({ reference: '003A-5F0A' })]);
    const target = await render([cashForm()], { scoped: true });
    await vi.waitFor(() =>
      expect(target.textContent).toContain(
        m.form_submitter_guest_reference({ reference: '003A-5F0A' })
      )
    );
  });

  it('names a guest by what they typed, beside the guest word and the reference', async () => {
    api.listPendingCashSubmissions.mockResolvedValueOnce([
      pendingRow({ reference: '003A-5F0A', guestFirstName: 'Ada', guestLastName: 'Test' }),
    ]);
    const target = await render([cashForm()], { scoped: true });
    await vi.waitFor(() =>
      expect(target.textContent).toContain(
        `Ada Test (${m.form_submitter_guest_reference({ reference: '003A-5F0A' })})`
      )
    );
  });

  it('validates a payment and drops its row; a form that takes no cash is never asked', async () => {
    api.listPendingCashSubmissions.mockResolvedValueOnce([pendingRow({ reference: 'R1' })]);
    const target = await render([cashForm(), form({ id: 'f2' })], { scoped: true });
    await vi.waitFor(() => expect(target.textContent).toContain(m.common_validate_button()));
    expect(api.listPendingCashSubmissions).toHaveBeenCalledTimes(1);
    expect(api.listPendingCashSubmissions).toHaveBeenCalledWith('f1');
    [...target.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === m.common_validate_button())!
      .click();
    await vi.waitFor(() => expect(api.validateCashSubmission).toHaveBeenCalledWith('f1', 'sub-1'));
    await vi.waitFor(() => expect(target.textContent).not.toContain(m.common_validate_button()));
  });

  // A switched answer paid online meanwhile: no cash to collect, said so, never "done" in silence.
  it('says an answer was already paid online, and drops it from the cash list', async () => {
    api.listPendingCashSubmissions.mockResolvedValueOnce([pendingRow({ reference: 'R1' })]);
    api.validateCashSubmission.mockRejectedValueOnce(
      new ApiRefusalError(409, 'CASH_ALREADY_PAID_ONLINE', 'paid online')
    );
    const target = await render([cashForm()], { scoped: true });
    await vi.waitFor(() => expect(target.textContent).toContain(m.common_validate_button()));
    [...target.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === m.common_validate_button())!
      .click();
    await vi.waitFor(() =>
      expect(toastStore.toasts.map((t) => t.message)).toContain(m.form_cash_already_paid_online())
    );
    await vi.waitFor(() => expect(target.textContent).not.toContain(m.common_validate_button()));
    toastStore.toasts.forEach((t) => dismissToast(t.id));
  });

  it('on the global list reads no pending cash at all: the accordion holds those actions', async () => {
    await render([cashForm(), form({ id: 'f2', allowCashPayment: true })]);
    expect(api.listPendingCashSubmissions).not.toHaveBeenCalled();
  });

  it('says there is nothing to validate on a form that takes cash and has none waiting', async () => {
    const target = await render([cashForm()], { scoped: true });
    await vi.waitFor(() => expect(target.textContent).toContain(m.asso_forms_no_pending_cash()));
  });
});

describe('FormsManagerList - closing a form (owner, 2026-11-16)', () => {
  it('shows the badge at once on the server verdict, whatever this device clock says', async () => {
    api.setFormClosed.mockResolvedValueOnce({
      id: 'f1',
      closedAt: new Date(Date.now() + 5000).toISOString(),
      windowState: 'closed',
    });
    const target = await render([form({})]);
    await openMenu(target, 'f1');
    entry('close')!.click();
    await vi.waitFor(() =>
      expect(target.querySelector('#form-f1 [data-testid="form-closed-badge"]')).not.toBeNull()
    );
  });

  it('closes after a confirmation, and the row gets its "Ferme" badge and a "Rouvrir" entry', async () => {
    const target = await render([form({})]);
    expect(target.querySelector('[data-testid="form-closed-badge"]')).toBeNull();
    await openMenu(target, 'f1');
    expect(entry('reopen')).toBeNull();
    entry('close')!.click();
    await vi.waitFor(() => expect(api.setFormClosed).toHaveBeenCalledWith('f1', true));
    expect(confirm.showConfirm).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(
        target.querySelector('#form-f1 [data-testid="form-closed-badge"]')!.textContent
      ).toContain(m.form_list_closed_badge())
    );
    await menuClosed();
    await openMenu(target, 'f1');
    expect(entry('close')).toBeNull();
    expect(entry('reopen')).not.toBeNull();
  });

  it('closes nothing when the confirmation is declined', async () => {
    confirm.showConfirm.mockResolvedValueOnce(false);
    const target = await render([form({})]);
    await openMenu(target, 'f1');
    entry('close')!.click();
    await vi.waitFor(() => expect(confirm.showConfirm).toHaveBeenCalledTimes(1));
    expect(api.setFormClosed).not.toHaveBeenCalled();
    expect(target.querySelector('[data-testid="form-closed-badge"]')).toBeNull();
  });

  it('reopens a closed form with no confirmation, and the badge goes', async () => {
    const target = await render([form({ closedAt: '2026-01-01T00:00:00.000Z' })]);
    expect(target.querySelector('[data-testid="form-closed-badge"]')).not.toBeNull();
    await openMenu(target, 'f1');
    entry('reopen')!.click();
    await vi.waitFor(() => expect(api.setFormClosed).toHaveBeenCalledWith('f1', false));
    expect(confirm.showConfirm).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(target.querySelector('[data-testid="form-closed-badge"]')).toBeNull()
    );
  });

  it('does not call a scheduled end, still to come, closed', async () => {
    const target = await render([form({ closedAt: '2099-01-01T00:00:00.000Z' })]);
    expect(target.querySelector('[data-testid="form-closed-badge"]')).toBeNull();
    await openMenu(target, 'f1');
    expect(entry('close')).not.toBeNull();
  });

  it('offers nothing to close on a form whose opening is still to come', async () => {
    const target = await render([form({ opensAt: '2099-01-01T00:00:00.000Z' })]);
    await openMenu(target, 'f1');
    expect(entry('close')).toBeNull();
    expect(entry('reopen')).toBeNull();
  });

  it('says the server refusal of a close, typed', async () => {
    api.setFormClosed.mockRejectedValueOnce(
      new ApiRefusalError(400, 'FORM_CLOSE_NOT_OPEN_YET', 'not open yet')
    );
    const target = await render([form({})]);
    await openMenu(target, 'f1');
    entry('close')!.click();
    await vi.waitFor(() => expect(api.setFormClosed).toHaveBeenCalledWith('f1', true));
    await vi.waitFor(() =>
      expect(toastStore.toasts.map((t) => t.message)).toContain(m.form_refusal_close_not_open_yet())
    );
    expect(target.querySelector('[data-testid="form-closed-badge"]')).toBeNull();
    toastStore.toasts.forEach((t) => dismissToast(t.id));
  });

  it('offers a draft nothing to close', async () => {
    const target = await render([form({ status: 'draft' })]);
    await openMenu(target, 'f1');
    expect(entry('close')).toBeNull();
    expect(entry('reopen')).toBeNull();
  });
});

describe('FormsManagerList - the question put to a form left open', () => {
  const card = (target: HTMLElement) =>
    target.querySelector<HTMLElement>('#form-f1 [data-testid="form-stale-open-card"]');
  const press = (target: HTMLElement, id: string) =>
    target.querySelector<HTMLButtonElement>(`#form-f1 [data-testid="${id}"]`)!.click();

  it('draws the card only on an open published form the server says is still asked about', async () => {
    const target = await render([
      form({ staleOpenAsk: true }),
      form({ id: 'f2', staleOpenAsk: false }),
      form({ id: 'f3', staleOpenAsk: true, status: 'draft' }),
      form({
        id: 'f4',
        staleOpenAsk: true,
        closedAt: '2026-01-01T00:00:00Z',
        windowState: 'closed',
      }),
    ]);
    expect(card(target)).not.toBeNull();
    for (const other of ['f2', 'f3', 'f4']) {
      expect(
        target.querySelector(`#form-${other} [data-testid="form-stale-open-card"]`)
      ).toBeNull();
    }
  });

  it('"Garder ouvert" tells the server and takes the card away, leaving the form open', async () => {
    const target = await render([form({ staleOpenAsk: true })]);
    press(target, 'form-stale-open-keep');
    await vi.waitFor(() => expect(api.keepFormOpen).toHaveBeenCalledWith('f1'));
    await vi.waitFor(() => expect(card(target)).toBeNull());
    expect(api.setFormClosed).not.toHaveBeenCalled();
  });

  it('"Fermer" is the close of the list itself, confirmation included, and takes the card away', async () => {
    const target = await render([form({ staleOpenAsk: true })]);
    press(target, 'form-stale-open-close');
    await vi.waitFor(() => expect(api.setFormClosed).toHaveBeenCalledWith('f1', true));
    expect(confirm.showConfirm).toHaveBeenCalled();
    await vi.waitFor(() => expect(card(target)).toBeNull());
  });

  it('keeps the card when the close is refused at the confirmation', async () => {
    confirm.showConfirm.mockResolvedValueOnce(false);
    const target = await render([form({ staleOpenAsk: true })]);
    press(target, 'form-stale-open-close');
    await vi.waitFor(() => expect(confirm.showConfirm).toHaveBeenCalled());
    expect(api.setFormClosed).not.toHaveBeenCalled();
    expect(card(target)).not.toBeNull();
  });

  it('"Fixer une date" sends the chosen instant as ISO and takes the card away', async () => {
    const target = await render([form({ staleOpenAsk: true })]);
    press(target, 'form-stale-open-date');
    flushSync();
    press(target, 'form-stale-open-date-confirm');
    await vi.waitFor(() => expect(api.setFormClosingDate).toHaveBeenCalledTimes(1));
    const [id, iso] = api.setFormClosingDate.mock.calls[0] as unknown as [string, string];
    expect(id).toBe('f1');
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    await vi.waitFor(() => expect(card(target)).toBeNull());
  });

  it('takes the card away when the server says the form is not open any more (409), and says so', async () => {
    api.setFormClosingDate.mockRejectedValueOnce(
      new ApiRefusalError(409, 'FORM_CLOSING_DATE_NOT_OPEN', 'not open')
    );
    const target = await render([form({ staleOpenAsk: true })]);
    press(target, 'form-stale-open-date');
    flushSync();
    press(target, 'form-stale-open-date-confirm');
    await vi.waitFor(() => expect(api.setFormClosingDate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(toastStore.toasts.map((t) => t.message)).toContain(
        m.form_refusal_closing_date_not_open()
      )
    );
    await vi.waitFor(() => expect(card(target)).toBeNull());
  });

  it('keeps the card and says so when the server refuses an answer', async () => {
    api.keepFormOpen.mockRejectedValueOnce(new Error('network'));
    const target = await render([form({ staleOpenAsk: true })]);
    press(target, 'form-stale-open-keep');
    await vi.waitFor(() => expect(api.keepFormOpen).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(toastStore.toasts.some((t) => t.message === m.form_stale_open_error())).toBe(true)
    );
    expect(card(target)).not.toBeNull();
  });
});
