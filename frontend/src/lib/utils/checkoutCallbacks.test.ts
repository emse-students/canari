// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ tauri: false, os: 'web' }));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => runtime.tauri }));
vi.mock('$lib/mls-client/mlsPlatform', () => ({ detectRuntimeDeviceOs: () => runtime.os }));
vi.mock('$lib/utils/publicAppUrl', () => ({
  publicAppUrl: (path: string) => `https://canari.example${path}`,
}));

import { formCheckoutCallbacks, shopCheckoutCallbacks } from './checkoutCallbacks';

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

describe('shopCheckoutCallbacks', () => {
  beforeEach(() => {
    runtime.tauri = false;
    runtime.os = 'web';
  });

  it('returns the web and Android on the https /shop link (an App Link on Android)', () => {
    expect(shopCheckoutCallbacks('p 1').successUrl).toBe(
      'https://canari.example/shop?purchase_success=1&productId=p%201'
    );
    runtime.tauri = true;
    runtime.os = 'android';
    expect(shopCheckoutCallbacks('p1')).toEqual({
      successUrl: 'https://canari.example/shop?purchase_success=1&productId=p1',
      cancelUrl: 'https://canari.example/shop?purchase_cancel=1',
    });
  });

  it('keeps iOS on the app scheme', () => {
    runtime.tauri = true;
    runtime.os = 'ios';
    expect(shopCheckoutCallbacks('p1').successUrl).toBe(
      'fr.emse.canari://payment/success?purchase_success=1&productId=p1'
    );
  });
});
