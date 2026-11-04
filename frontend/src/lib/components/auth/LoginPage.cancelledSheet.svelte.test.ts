// @vitest-environment happy-dom
/**
 * A SIGN-IN SHEET THE USER CLOSED HANDS THE BUTTON BACK (iPhone 12, `1.6.3-alpha.7`, 2026-11-03).
 *
 * On iOS the sign-in runs in an in-app sheet, and closing it raises no visibility, focus or
 * foreground edge - the only events the page used to release its busy button on - so the button
 * stayed on "Redirection..." until the app was killed. The plugin now answers how the sheet ended,
 * and `cancelled` is what releases the form; every other outcome keeps it busy, because a
 * navigation, the callback's deep link or the foreground edge follows it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import type { OidcLoginStart } from '$lib/stores/auth';

const startOidcLogin = vi.hoisted(() => vi.fn<(...a: unknown[]) => Promise<OidcLoginStart>>());

vi.mock('$lib/stores/auth', () => ({
  startOidcLogin: (...a: unknown[]) => startOidcLogin(...a),
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
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => true }));
vi.mock('$lib/utils/appForeground', () => ({ onAppForegroundChange: () => () => {} }));
vi.mock('$lib/navigation/gotoAppPath', () => ({ gotoAppPath: vi.fn(async () => {}) }));
// The form's fade and slide are not under test, and happy-dom rejects their animation on unmount.
vi.mock('svelte/transition', () => ({ fade: () => ({}), slide: () => ({}) }));

const { default: LoginPage } = await import('./LoginPage.svelte');

let app: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (app) void unmount(app);
  app = null;
  startOidcLogin.mockReset();
  document.body.innerHTML = '';
});

/** Settles the promise chain of a click: the version check, the sign-in start, the re-render. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await tick();
  flushSync();
}

async function mountPage(): Promise<HTMLButtonElement> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  app = mount(LoginPage, { target });
  await settle();
  // The MiConnect button is the first one the form draws.
  return document.querySelector('button') as HTMLButtonElement;
}

describe('LoginPage - how the sign-in sheet ended decides the button', () => {
  it('hands the button back when the user closed the sheet', async () => {
    startOidcLogin.mockResolvedValue('cancelled');
    const button = await mountPage();
    expect(button.disabled).toBe(false);

    button.click();
    await settle();

    expect(startOidcLogin).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(false);
  });

  it.each<OidcLoginStart>(['completed', 'handedOff', 'navigating'])(
    'keeps the button busy on %s - something else follows it',
    async (start) => {
      startOidcLogin.mockResolvedValue(start);
      const button = await mountPage();

      button.click();
      await settle();

      expect(startOidcLogin).toHaveBeenCalledTimes(1);
      expect(button.disabled).toBe(true);
    }
  );

  it('hands the button back with an error when the sheet failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startOidcLogin.mockRejectedValue(new Error('ASWebAuthenticationSession failed'));
    const button = await mountPage();

    button.click();
    await settle();

    expect(button.disabled).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
