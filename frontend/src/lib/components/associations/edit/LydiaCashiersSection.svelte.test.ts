// @vitest-environment happy-dom
/**
 * "TRANSFERER LE ROLE" (owner, 2026-11-19): the Responsable - or a platform admin - picks a member
 * and types their number, reads the consequence ("X deviendra Responsable ; votre numero perdra ses
 * droits Lydia") and only then is anything sent. The gate ships OFF, so the specs open it through
 * the view's own parameter; off, the button is never drawn.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AssociationPayoutAccount, LydiaCashier } from '$lib/associations/api';
import { SocialApiError } from '$lib/associations/api';
import { m } from '$lib/paraglide/messages';
import { settleUntilStable } from '../../../../test/flush';
import { adoptTransitionAnimations } from '../../../../test/adoptTransitionAnimations';

// The member Picker's closing transition outlives an unmounted test under happy-dom.
afterAll(adoptTransitionAnimations());

const state = vi.hoisted(() => ({
  gate: true,
  me: 'u-resp' as string | null,
  admin: false,
  confirmAnswer: true,
  confirm: vi.fn(),
  handOver: vi.fn(),
}));

vi.mock('$lib/associations/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/associations/api')>()),
  listMembers: vi.fn(() =>
    Promise.resolve([
      { userId: 'u-resp', displayName: 'Rita' },
      { userId: 'u-plain', displayName: 'Paul' },
      { userId: 'u-heir', displayName: 'Hugo' },
    ])
  ),
  handOverLydiaResponsable: state.handOver,
}));

vi.mock('$lib/associations/lydiaCashiers', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/associations/lydiaCashiers')>();
  return {
    ...real,
    // The shipped gate is OFF; the specs choose it.
    lydiaCashiersView: (
      account: AssociationPayoutAccount,
      add?: boolean,
      viewer?: { userId: string | null; globalAdmin: boolean }
    ) => real.lydiaCashiersView(account, add, viewer, state.gate),
  };
});

vi.mock('$lib/stores/user', () => ({
  currentUserId: () => state.me,
  isGlobalAdmin: () => state.admin,
}));

vi.mock('$lib/stores/confirm.svelte', () => ({
  showConfirm: (message: string, opts: unknown) => {
    state.confirm(message, opts);
    return Promise.resolve(state.confirmAnswer);
  },
}));

import LydiaCashiersSection from './LydiaCashiersSection.svelte';

const responsable: LydiaCashier = {
  id: 'row-resp',
  userId: 'u-resp',
  name: 'Rita',
  role: 'responsable',
  phoneEnd: '32',
  state: 'confirmed',
  previousPhoneEnd: null,
  addedAt: '2026-11-01T10:00:00.000Z',
  addedByName: 'Rita',
};
const account: AssociationPayoutAccount = {
  lydiaAccountId: 'vendor',
  lydiaDashboardUrl: null,
  lydiaOnboardingComplete: true,
  responsable: { userId: 'u-resp', name: 'Rita', phoneEnd: '32', confirmed: true },
  cashiers: [responsable],
  // Paul is a member without MANAGE_PAYOUT_ACCOUNT: never offered as the heir (owner, 2026-11-20).
  payoutManagerIds: ['u-resp', 'u-heir'],
};

const mounted: (() => void)[] = [];
afterEach(() => {
  state.gate = true;
  state.me = 'u-resp';
  state.admin = false;
  state.confirmAnswer = true;
  state.confirm.mockReset();
  state.handOver.mockReset();
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function render(reload = vi.fn(() => Promise.resolve())) {
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(LydiaCashiersSection, {
    target,
    props: { associationId: 'asso-1', account, reload },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return { target, reload };
}

const button = (target: HTMLElement, label: string) =>
  [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

/** Opens the form, picks the heir, types `phone` and submits. */
async function handOverTo(target: HTMLElement, phone: string) {
  button(target, m.asso_lydia_handover_button())!.click();
  await settleUntilStable(() => target.querySelector('#lydia-handover-member')?.textContent);
  const picker = target.querySelector<HTMLButtonElement>('#lydia-handover-member')!;
  // The first member is chosen as the form opens.
  expect(picker.textContent?.trim()).toBe('Hugo');
  picker.click();
  flushSync();
  // Neither the Responsable nor a member without the payout right is offered: the heir alone.
  const offered = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  expect(offered.map((o) => o.textContent?.trim())).toEqual(['Hugo']);
  offered[0].click();
  flushSync();
  const input = target.querySelector<HTMLInputElement>('input[type="tel"]')!;
  input.value = phone;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  button(target, m.asso_lydia_handover_submit())!.click();
  await settleUntilStable(() => target.textContent);
}

describe('LydiaCashiersSection - handing the Responsable over', () => {
  it('gate off (shipped): no "Transferer le role"', () => {
    state.gate = false;
    const { target } = render();
    expect(button(target, m.asso_lydia_handover_button())).toBeUndefined();
  });

  it('a payout manager who is not the Responsable does not see it; a platform admin does', () => {
    state.me = 'u-treasurer';
    expect(button(render().target, m.asso_lydia_handover_button())).toBeUndefined();
    state.admin = true;
    expect(button(render().target, m.asso_lydia_handover_button())).toBeDefined();
  });

  it('the Responsable: picks a member and a number, reads the consequence, then it is sent', async () => {
    state.handOver.mockResolvedValue({ previousNumberRemoved: true });
    const { target, reload } = render();
    await handOverTo(target, '06 11 11 22 22');
    expect(state.confirm).toHaveBeenCalledWith(
      m.asso_lydia_handover_confirm_self({ name: 'Hugo' }),
      expect.objectContaining({ danger: true })
    );
    expect(state.handOver).toHaveBeenCalledWith('asso-1', {
      userId: 'u-heir',
      phone: '+33611112222',
    });
    expect(target.textContent).toContain(m.asso_lydia_handover_done({ name: 'Hugo' }));
    expect(reload).toHaveBeenCalled();
  });

  it('a platform admin reads which number loses its rights', async () => {
    state.me = 'u-admin';
    state.admin = true;
    state.handOver.mockResolvedValue({ previousNumberRemoved: false });
    const { target } = render();
    await handOverTo(target, '+33611112222');
    expect(state.confirm).toHaveBeenCalledWith(
      m.asso_lydia_handover_confirm_admin({ name: 'Hugo', phoneEnd: '32' }),
      expect.anything()
    );
    // The old number's removal not confirmed: said, and the card (re-read) lists it to remove.
    expect(target.textContent).toContain(m.asso_lydia_handover_done_old_kept({ name: 'Hugo' }));
  });

  it('declining the confirmation sends nothing', async () => {
    state.confirmAnswer = false;
    const { target } = render();
    await handOverTo(target, '+33611112222');
    expect(state.handOver).not.toHaveBeenCalled();
  });

  it('a number that is not a phone is refused on the screen, nothing asked', async () => {
    const { target } = render();
    await handOverTo(target, '12');
    expect(state.confirm).not.toHaveBeenCalled();
    expect(target.textContent).toContain(m.asso_lydia_resp_phone_format_error());
  });

  it('Lydia not confirming the rights: the typed sentence, and the card re-read', async () => {
    state.handOver.mockRejectedValue(
      new SocialApiError('x', 'LYDIA_CASHIER_RIGHTS_INCOMPLETE', 502)
    );
    const { target, reload } = render();
    await handOverTo(target, '+33611112222');
    expect(target.textContent).toContain(m.asso_lydia_handover_err_unconfirmed());
    expect(reload).toHaveBeenCalled();
  });
});
