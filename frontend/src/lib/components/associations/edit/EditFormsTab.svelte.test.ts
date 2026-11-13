// @vitest-environment happy-dom
/**
 * THE TAB IS THE SHARED LIST, SCOPED. Its rows are `FormsManagerList`'s (tested there); what is the
 * tab's own is pinned here: the forms it reads are THIS association's, "Nouveau formulaire"
 * creates a form already attached to it and comes back to this tab, and the paid-forms banner.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Association } from '$lib/associations/api';
import { m } from '$lib/paraglide/messages';
import { flushMacrotask } from '../../../../test/flush';

const state = vi.hoisted(() => ({ forms: [] as unknown[] }));

vi.mock('$lib/forms/associationForms', () => ({
  loadAssociationForms: vi.fn(() => Promise.resolve(state.forms)),
}));
vi.mock('$lib/forms/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/forms/api')>()),
  listPendingCashSubmissions: vi.fn(() => Promise.resolve([])),
}));

import EditFormsTab from './EditFormsTab.svelte';
import { loadAssociationForms } from '$lib/forms/associationForms';

const asso = { id: 'asso-1', slug: 'club', type: 'association' } as unknown as Association;

let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

async function render(onlinePaymentsReady = true): Promise<HTMLElement> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(EditFormsTab, {
    target,
    props: {
      asso,
      onlinePaymentsReady,
      canManagePayoutAccount: true,
      onGoToPayments: () => {},
    },
  });
  await flushMacrotask();
  await flushMacrotask();
  flushSync();
  return target;
}

const paid = { id: 'form-1', title: 'Merch', basePrice: 2800, items: [], associationName: 'Club' };

describe('EditFormsTab', () => {
  it("reads this association's forms and omits the association name on each row", async () => {
    state.forms = [paid];
    const target = await render();
    expect(loadAssociationForms).toHaveBeenCalledWith('asso-1');
    expect(target.querySelector('#form-form-1')).not.toBeNull();
    expect(target.textContent).not.toContain(
      m.form_list_association_badge({ association: 'Club' })
    );
  });

  it('creates a form already attached to the association, and returns to this tab', async () => {
    state.forms = [];
    const target = await render();
    const hrefs = [...target.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    const create = hrefs.find((h) => h?.startsWith('/forms/create'))!;
    const query = new URL(create, 'https://canari.test').searchParams;
    expect(query.get('association')).toBe('asso-1');
    expect(query.get('returnTo')).toContain('club');
  });

  it('warns once when a form is paid and payments are not configured, and not otherwise', async () => {
    state.forms = [paid];
    const target = await render(false);
    expect(target.querySelector('[data-testid="payments-link"]')).not.toBeNull();
    unmount(component!);
    component = null;
    document.body.innerHTML = '';
    expect((await render(true)).querySelector('[data-testid="payments-link"]')).toBeNull();
  });

  // A button is an atomic inline box, so a long link label could not break and jumped to its own
  // line, leaving the closing full stop alone (iPhone, 2026-11-08); `inline` lets it flow.
  it('lets the banner link flow inside the sentence and keeps the full stop right after it', async () => {
    state.forms = [paid];
    const target = await render(false);
    const link = target.querySelector('[data-testid="payments-link"]')!;
    expect(link.classList).toContain('inline');
    expect(link.classList).toContain('p-0');
    expect(link.nextSibling?.textContent?.trim()).toBe('.');
  });
});
