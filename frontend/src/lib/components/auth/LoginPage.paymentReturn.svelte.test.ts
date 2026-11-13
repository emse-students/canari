// @vitest-environment happy-dom
/**
 * A PAYER LEFT IN THE PHONE'S BROWSER IS TOLD WHERE THE PAYMENT WENT (2026-11-13). The Android
 * return reaches `/forms/success` in the browser when the App Link is not handed to the app; with
 * no Canari session there, the boot sends the page to `/login` with the return behind it. The login
 * page says the payment was handed to Lydia and offers the app, instead of only asking for a
 * sign-in to someone who just paid.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import { m } from '$lib/paraglide/messages';

vi.mock('$lib/stores/auth', () => ({
  startOidcLogin: vi.fn(),
  hasStoredSession: async () => false,
  getToken: async () => 'token',
  PASSWORD_LOGIN_FLOW_SLUG: 'password-login',
}));
vi.mock('$lib/stores/appVersionCheck.svelte', () => ({
  getAppVersionCheck: () => null,
  isBelowMinClientVersion: () => false,
  refreshAppVersionCheck: async () => {},
}));
vi.mock('$lib/services/biometric', () => ({
  BiometricService: { isAvailable: async () => false },
}));
vi.mock('$lib/services/restoreCredential', () => ({
  attemptRestore: async () => ({ outcome: 'not-applicable' }),
}));
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => false }));
vi.mock('$lib/utils/appForeground', () => ({ onAppForegroundChange: () => () => {} }));
vi.mock('$lib/navigation/gotoAppPath', () => ({ gotoAppPath: vi.fn(async () => {}) }));
vi.mock('svelte/transition', () => ({ fade: () => ({}), slide: () => ({}) }));

const { default: LoginPage } = await import('./LoginPage.svelte');

let app: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (app) void unmount(app);
  app = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function mountAt(path: string): Promise<void> {
  history.replaceState(null, '', path);
  const target = document.createElement('div');
  document.body.appendChild(target);
  app = mount(LoginPage, { target });
  for (let i = 0; i < 10; i++) await tick();
  flushSync();
}

describe('LoginPage in front of a payment return', () => {
  it('says the payment went to Lydia and offers the app on that answer', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await mountAt(
      `/login?returnTo=${encodeURIComponent('/forms/success?submission_id=s1&transaction=AB')}`
    );
    const note = document.querySelector('[data-payment-return]');
    expect(note?.textContent).toContain(m.form_payment_handed_heading());
    expect(note?.querySelector('a')?.getAttribute('href')).toBe(
      'fr.emse.canari://payment/success?submission_id=s1'
    );
  });

  it('does the same in front of a shop purchase return, carrying its attempt', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await mountAt(
      `/login?returnTo=${encodeURIComponent('/shop?purchase_success=1&productId=p1&checkout_id=c1&association_id=a1')}`
    );
    const href = document.querySelector('[data-payment-return] a')?.getAttribute('href') ?? '';
    expect(href.startsWith('fr.emse.canari://payment/success?')).toBe(true);
    expect(new URLSearchParams(href.split('?')[1]).get('checkout_id')).toBe('c1');
  });

  it('says nothing of a payment in front of any other page', async () => {
    await mountAt(`/login?returnTo=${encodeURIComponent('/forms/f1')}`);
    expect(document.querySelector('[data-payment-return]')).toBeNull();
  });
});
