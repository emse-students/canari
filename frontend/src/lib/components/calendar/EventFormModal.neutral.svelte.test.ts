// @vitest-environment happy-dom
/**
 * THE NEUTRAL CHOICE IN THE REAL FORM (owner, 2026-11-08): a BDE's agenda managers file an event
 * "au nom du BDE" or neutral ("Campus"). The switch is drawn only where the surface may decide it,
 * and choosing neutral takes the co-organiser picker and the form link out of the form - the two
 * things a neutral event may not carry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  listAssociations: async () => [],
}));

import { setLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import EventFormModal from './EventFormModal.svelte';
import {
  blankEventFormValues,
  toCreatePayload,
  type EventFormCapabilities,
} from '$lib/calendar/eventForm';
import { flushMacrotask } from '../../../test/flush';

const mounted: ReturnType<typeof mount>[] = [];

beforeEach(() => setLocale('en', { reload: false }));
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

async function open(
  values: ReturnType<typeof blankEventFormValues>,
  capabilities: EventFormCapabilities,
  onSubmit = async () => {}
) {
  mounted.push(
    mount(EventFormModal, {
      target: document.body,
      props: {
        open: true,
        heading: 'h',
        values,
        capabilities,
        linkableForms: [{ id: 'form-1', title: 'Inscriptions' }],
        submitLabel: 'go',
        savingLabel: 'saving',
        onSubmit,
        onClose: () => {},
      },
    })
  );
  flushSync();
  await flushMacrotask();
  flushSync();
}

function neutralSwitch(): HTMLInputElement | null {
  return document.querySelector('[data-event-presentation] input[type="checkbox"]');
}

const coOwnerSearch = () =>
  document.querySelector(`input[placeholder="${m.asso_calendar_co_owner_search_placeholder()}"]`);

describe('the neutral event switch', () => {
  it('is not drawn for a surface that may not decide it', async () => {
    const values = $state({ ...blankEventFormValues(), title: 'Perm', targetAssociationId: 'c1' });
    await open(values, { canLinkForm: true });
    expect(neutralSwitch()).toBeNull();
    expect(document.body.textContent).not.toContain(m.asso_calendar_event_neutral_label());
  });

  it('files a neutral event with no partner and no form, and hides both pickers', async () => {
    const values = $state({
      ...blankEventFormValues(),
      title: 'Soiree',
      targetAssociationId: 'bde-id',
      coOwnerIds: ['club-1'],
      linkedFormId: 'form-1',
    });
    const caps = { canSetPresentation: true, canLinkForm: true };
    const sent: ReturnType<typeof toCreatePayload>[] = [];
    await open(values, caps, async () => {
      sent.push(toCreatePayload(values, caps));
    });

    expect(document.body.textContent).toContain(m.asso_calendar_event_neutral_label());
    expect(coOwnerSearch()).not.toBeNull();
    expect(document.body.textContent).toContain(m.asso_calendar_link_form_label());

    neutralSwitch()!.click();
    flushSync();

    expect(values.presentation).toBe('neutral');
    expect(coOwnerSearch()).toBeNull();
    expect(document.body.textContent).not.toContain(m.asso_calendar_link_form_label());

    [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'go')!.click();
    await flushMacrotask();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ presentation: 'neutral', coOwnerIds: [] });
    expect(sent[0]).not.toHaveProperty('linkedFormId');
  });
});
