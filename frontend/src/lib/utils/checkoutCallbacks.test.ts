// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ tauri: false, os: 'web' }));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => runtime.tauri }));
vi.mock('$lib/mls-client/mlsPlatform', () => ({ detectRuntimeDeviceOs: () => runtime.os }));
vi.mock('$lib/utils/publicAppUrl', () => ({
  publicAppUrl: (path: string) => `https://canari.example${path}`,
}));

import { formCheckoutCallbacks } from './checkoutCallbacks';

describe('formCheckoutCallbacks', () => {
  beforeEach(() => {
    runtime.tauri = false;
    runtime.os = 'web';
  });

  it('returns the web to the https return pages', () => {
    expect(formCheckoutCallbacks()).toEqual({
      successUrl: 'https://canari.example/forms/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://canari.example/forms/cancel?session_id={CHECKOUT_SESSION_ID}',
    });
  });

  it('returns Android on the same https pages - an App Link under /forms/, not the app scheme', () => {
    runtime.tauri = true;
    runtime.os = 'android';
    const { successUrl, cancelUrl } = formCheckoutCallbacks();
    expect(successUrl).toBe(
      'https://canari.example/forms/success?session_id={CHECKOUT_SESSION_ID}'
    );
    expect(cancelUrl).toBe('https://canari.example/forms/cancel?session_id={CHECKOUT_SESSION_ID}');
  });

  it('keeps iOS on the app scheme', () => {
    runtime.tauri = true;
    runtime.os = 'ios';
    expect(formCheckoutCallbacks().successUrl).toBe(
      'fr.emse.canari://payment/success?session_id={CHECKOUT_SESSION_ID}'
    );
  });
});
