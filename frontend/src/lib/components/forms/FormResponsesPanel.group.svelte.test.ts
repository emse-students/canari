// @vitest-environment happy-dom
/**
 * "CRÉER UN GROUPE" FROM A FORM'S RESPONDENTS (owner, 2026-11-19): the button exists on a named,
 * internal form and nowhere else, it fills the new-discussion panel's picker through `groupDraft`
 * and opens the chat page, and a respondent whose account is gone is said, never silently dropped.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Form, Submission } from '$lib/forms/api';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { groupDraft } from '$lib/stores/groupDraft.svelte';

const getFormRespondents = vi.hoisted(() => vi.fn());
const goto = vi.hoisted(() => vi.fn(async () => {}));
const toast = vi.hoisted(() => vi.fn());

vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: toast }));
vi.mock('$lib/stores/user', async (original) => ({
  ...(await original<typeof import('$lib/stores/user')>()),
  getSavedUserId: () => 'me',
}));
vi.mock('$lib/associations/api', () => ({
  listAssociationPurchases: vi.fn(async () => []),
  listAssociationRefunds: vi.fn(async () => ({ standings: [], refunds: [] })),
}));
vi.mock('$lib/forms/api', async (original) => ({
  ...(await original<typeof import('$lib/forms/api')>()),
  getFormRespondents,
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
  getFormRespondents.mockReset();
  goto.mockClear();
  toast.mockClear();
  groupDraft.takeFor('me');
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const baseForm = {
  id: 'f1',
  title: 'Sondage',
  items: [{ id: 'q', label: 'Q', required: false, type: 'short_text' }],
  requiresPayment: false,
  createdAt: '2026-11-06T10:00:00.000Z',
  updatedAt: '2026-11-06T10:00:00.000Z',
} as Form;

const answer = (id: string, userId: string | null): Submission =>
  ({
    id,
    formId: 'f1',
    userId,
    firstName: 'A',
    lastName: 'B',
    email: null,
    answers: { q: 'x' },
    totalPaid: 0,
    paymentStatus: 'free',
    paymentMethod: null,
    createdAt: '2026-11-06T10:00:00.000Z',
  }) as Submission;

function render(over: Partial<Form> = {}, submissions = [answer('s1', 'u1')]) {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(FormResponsesPanel, {
    target,
    props: {
      form: { ...baseForm, ...over } as Form,
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

const button = (target: HTMLElement) =>
  target.querySelector<HTMLButtonElement>('[data-testid="responses-make-group"]');

async function press(target: HTMLElement) {
  button(target)!.click();
  await vi.waitFor(() => expect(getFormRespondents).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

describe('the "Créer un groupe" button', () => {
  it('is drawn on a named, internal form', () => {
    expect(button(render())).not.toBeNull();
  });

  it('is absent on an anonymous form, and on a public one', () => {
    expect(button(render({ anonymous: true }))).toBeNull();
    expect(button(render({ isPublic: true }))).toBeNull();
  });

  it('is absent while nobody has answered', () => {
    expect(button(render({}, []))).toBeNull();
  });

  it('fills the draft with the respondents, never the signed-in account, and opens the chat page', async () => {
    getFormRespondents.mockResolvedValue({
      respondents: [
        { id: 'u1', firstName: 'Ada', lastName: 'Lovelace' },
        { id: 'me', firstName: 'Me', lastName: null },
        { id: 'u2', firstName: 'Alan', lastName: 'Turing' },
      ],
      departed: 0,
    });
    await press(render());
    expect(groupDraft.pending?.members.map((p) => p.id)).toEqual(['u1', 'u2']);
    expect(groupDraft.pending?.members[0].name).toBe('Ada Lovelace');
    expect(goto).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it('says how many respondents left, and still opens the panel on the others', async () => {
    getFormRespondents.mockResolvedValue({
      respondents: [
        { id: 'u1', firstName: 'Ada', lastName: null },
        { id: 'u2', firstName: 'Alan', lastName: null },
      ],
      departed: 3,
    });
    await press(render());
    expect(toast).toHaveBeenCalledTimes(1);
    expect(String(toast.mock.calls[0][0])).toContain('3');
    expect(groupDraft.pending?.members).toHaveLength(2);
    expect(goto).toHaveBeenCalled();
  });

  it('refuses fewer than two other people, in a toast, and leaves no draft', async () => {
    getFormRespondents.mockResolvedValue({
      respondents: [{ id: 'u1', firstName: 'Ada', lastName: null }],
      departed: 0,
    });
    await press(render());
    expect(toast).toHaveBeenCalledTimes(1);
    expect(groupDraft.pending).toBeNull();
    expect(goto).not.toHaveBeenCalled();
  });

  it('says a refusal of the server, and leaves no draft', async () => {
    getFormRespondents.mockRejectedValue(
      new ApiRefusalError(409, 'FORM_RESPONDENTS_ANONYMOUS', 'refused')
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await press(render());
    expect(err).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(groupDraft.pending).toBeNull();
    expect(goto).not.toHaveBeenCalled();
  });
});
