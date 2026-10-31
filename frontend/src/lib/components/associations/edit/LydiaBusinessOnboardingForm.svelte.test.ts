// @vitest-environment happy-dom
/**
 * AN ONBOARDING WHOSE OUTCOME IS UNKNOWN NEVER SAYS "SAVE ERROR". No answer reached the screen (a
 * code-less 504 here), so Lydia may have created the Business: the form re-reads the payout
 * account. Linked after all, it shows the linked state and no error; still unlinked, it shows the
 * "check before retrying" line - never the generic save error, which invites the retry that would
 * create a second Business.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Association, AssociationPayoutAccount } from '$lib/associations/api';
import { SocialApiError } from '$lib/associations/api';
import { m } from '$lib/paraglide/messages';
import { settleUntilStable } from '../../../../test/flush';

const state = vi.hoisted(() => ({
  reads: [] as AssociationPayoutAccount[],
  start: vi.fn(),
}));

vi.mock('$lib/associations/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/associations/api')>()),
  getAssociationPayoutAccount: vi.fn(() => Promise.resolve(state.reads.shift())),
  startLydiaOnboarding: state.start,
  listMembers: vi.fn(() => Promise.resolve([])),
}));

vi.mock('$lib/stores/user', () => ({ isGlobalAdmin: () => false, getSavedUserId: () => 'u1' }));

import LydiaBusinessOnboardingForm from './LydiaBusinessOnboardingForm.svelte';

const unlinked: AssociationPayoutAccount = {
  lydiaAccountId: null,
  lydiaDashboardUrl: null,
  lydiaOnboardingComplete: false,
};
const linked: AssociationPayoutAccount = {
  lydiaAccountId: 'vendor-late',
  lydiaDashboardUrl: 'https://lydia.example/d',
  lydiaOnboardingComplete: false,
};

const asso = {
  id: 'asso-1',
  name: 'BDE',
  type: 'association',
  contactEmail: 'bde@test.example',
} as unknown as Association;

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** Mounts the form on an unlinked account, fills every field and submits it. */
async function submitWithUnknownOutcome(reread: AssociationPayoutAccount) {
  state.reads = [unlinked, reread];
  state.start.mockRejectedValue(new SocialApiError('Gateway Time-out', null, 504));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(LydiaBusinessOnboardingForm, {
    target,
    props: { asso, onDisconnected: () => undefined, onValidated: () => undefined },
  });
  mounted.push(() => unmount(component));
  await settleUntilStable(() => target.querySelectorAll('input').length);
  for (const input of target.querySelectorAll('input')) {
    if (input.value) continue;
    input.value = input.type === 'tel' ? '+33100000000' : 'x';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  flushSync();
  const submit = [...target.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === m.asso_lydia_submit_button()
  );
  expect(submit).toBeDefined();
  submit!.click();
  await settleUntilStable(() => target.textContent);
  return target;
}

describe('LydiaBusinessOnboardingForm - an unknown outcome is re-read, never a save error', () => {
  it('re-reads a Business linked after all: the linked state, and no error line', async () => {
    const target = await submitWithUnknownOutcome(linked);
    expect(state.start).toHaveBeenCalledTimes(1);
    // The linked state asks for the Responsable; the technical id and the dashboard never show.
    expect(target.textContent).toContain(m.asso_lydia_resp_intro());
    expect(target.textContent).not.toContain('vendor-late');
    expect(target.textContent).not.toContain('lydia.example');
    expect(target.textContent).not.toContain('Ouvrir le tableau de bord Lydia');
    expect(target.textContent).not.toContain(m.asso_lydia_onboarding_unconfirmed_error());
    expect(target.textContent).not.toContain(m.common_save_error());
  });

  it('re-reads no Business: the "check before retrying" line, never the generic save error', async () => {
    const target = await submitWithUnknownOutcome(unlinked);
    expect(target.textContent).toContain(m.asso_lydia_onboarding_unconfirmed_error());
    expect(target.textContent).not.toContain(m.common_save_error());
  });
});

describe('LydiaBusinessOnboardingForm - the steps come from the server read', () => {
  async function mountWith(account: AssociationPayoutAccount) {
    state.reads = [account];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const target = document.createElement('div');
    document.body.appendChild(target);
    const component = mount(LydiaBusinessOnboardingForm, {
      target,
      props: { asso, onDisconnected: () => undefined, onValidated: () => undefined },
    });
    mounted.push(() => unmount(component));
    await settleUntilStable(() => target.textContent);
    return target;
  }

  it('a confirmed Responsable and an unready Business: the Lydia instructions, never the token', async () => {
    const target = await mountWith({
      ...linked,
      responsable: { userId: 'u1', name: 'Ada', phoneEnd: '78' },
    });
    expect(target.textContent).toContain(m.asso_lydia_resp_done({ name: 'Ada', phoneEnd: '78' }));
    expect(target.textContent).toContain(m.asso_lydia_activate_console());
    expect(target.textContent).toContain(m.asso_lydia_validation_waiting());
    expect(target.textContent).not.toContain('vendor-late');
    expect(target.textContent).not.toContain('tableau de bord');
  });

  it('a ready Business without a Responsable folds to "active" and offers the record prompt', async () => {
    const target = await mountWith({ ...linked, lydiaOnboardingComplete: true });
    expect(target.textContent).toContain(m.asso_lydia_active_title());
    expect(target.textContent).toContain(m.asso_lydia_resp_record_intro());
  });

  it('an in-flight enrolment says to check before retrying and offers no details form', async () => {
    const target = await mountWith({ ...unlinked, enrolmentInFlightSince: '2026-10-30T10:00:00Z' });
    expect(target.textContent).toContain(m.asso_lydia_in_flight_notice());
    expect(target.querySelectorAll('input').length).toBe(0);
  });

  it('a paused Business shows the date and the cause', async () => {
    const target = await mountWith({
      ...linked,
      responsable: { userId: 'u1', name: 'Ada', phoneEnd: '78' },
      readiness: { cause: 'request-blocked', at: '2026-10-30T10:00:00Z' },
    });
    expect(target.textContent).toContain(m.asso_lydia_paused_blocked());
  });
});
