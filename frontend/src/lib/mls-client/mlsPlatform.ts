/** Best-effort OS label from `navigator.userAgent` (browser or WebView). */
export function detectRuntimeDeviceOs(fallback: 'web' | 'desktop' = 'web'): string {
  if (typeof navigator === 'undefined') return fallback;
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('android')) return 'android';
  if (ua.includes('iphone') || ua.includes('ipad')) return 'ios';
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('mac os') || ua.includes('macintosh')) return 'macos';
  if (ua.includes('linux')) return 'linux';
  return fallback;
}
