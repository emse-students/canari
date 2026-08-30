import { platform } from '@tauri-apps/plugin-os';

import { isTauriRuntime } from '$lib/utils/openExternal';

/**
 * OS label stored on the device row (`deviceOs`) and used to pick a native calendar path.
 *
 * Inside a Tauri build the answer is the COMPILE-TIME target, never the user agent: an iPad
 * WKWebView says "Macintosh" (desktop-class browsing above 375 px), so the string test below
 * used to file every iPad under `macos`. `platform()` returns the same vocabulary this function
 * has always produced (`android`, `ios`, `windows`, `macos`, `linux`).
 *
 * On the web there is no native side to ask, so the user agent IS the only evidence - and it
 * lies the same way, which is why iPadOS Safari is recognised by its touch points instead.
 */
export function detectRuntimeDeviceOs(fallback: 'web' | 'desktop' = 'web'): string {
  if (isTauriRuntime()) return platform();
  if (typeof navigator === 'undefined') return fallback;
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('android')) return 'android';
  if (ua.includes('iphone') || ua.includes('ipad')) return 'ios';
  if (ua.includes('windows')) return 'windows';
  // An iPad in Safari claims to be a Mac; a real Mac reports at most one touch point.
  if (ua.includes('mac os') || ua.includes('macintosh')) {
    return navigator.maxTouchPoints > 1 ? 'ios' : 'macos';
  }
  if (ua.includes('linux')) return 'linux';
  return fallback;
}
