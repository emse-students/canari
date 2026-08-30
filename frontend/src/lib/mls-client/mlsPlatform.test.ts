// The native side is the source of truth for the platform; the mocks below stand in for it.
const nativeRuntime = vi.hoisted(() => ({ tauri: false, os: 'ios' }));
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => nativeRuntime.tauri }));
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => nativeRuntime.os }));

import { detectRuntimeDeviceOs } from './mlsPlatform';

/** What an iPad answers - in a WKWebView and in Safari alike, it names no Apple device. */
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';

function pretendBrowser(ua: string, maxTouchPoints: number) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
}

describe('detectRuntimeDeviceOs', () => {
  afterEach(() => {
    nativeRuntime.tauri = false;
    nativeRuntime.os = 'ios';
  });

  it('labels an iPad build ios, not macos, despite its user agent', () => {
    nativeRuntime.tauri = true;
    nativeRuntime.os = 'ios';
    pretendBrowser(IPAD_UA, 5);
    expect(detectRuntimeDeviceOs('desktop')).toBe('ios');
  });

  it('takes the native platform over the user agent inside Tauri', () => {
    nativeRuntime.tauri = true;
    nativeRuntime.os = 'android';
    pretendBrowser(IPAD_UA, 5);
    expect(detectRuntimeDeviceOs('desktop')).toBe('android');
  });

  // On the web the user agent is the only evidence there is, and it lies the same way:
  // touch points are what separates an iPad from the Mac it claims to be.
  it('separates an iPad browser from a Mac by its touch points', () => {
    pretendBrowser(IPAD_UA, 5);
    expect(detectRuntimeDeviceOs()).toBe('ios');
    pretendBrowser(IPAD_UA, 0);
    expect(detectRuntimeDeviceOs()).toBe('macos');
  });

  it('still reads the platforms that never lied', () => {
    pretendBrowser('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36', 5);
    expect(detectRuntimeDeviceOs()).toBe('android');
    pretendBrowser(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15',
      5
    );
    expect(detectRuntimeDeviceOs()).toBe('ios');
    pretendBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 0);
    expect(detectRuntimeDeviceOs()).toBe('windows');
  });
});
