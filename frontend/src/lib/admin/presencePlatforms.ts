import { m } from '$lib/paraglide/messages';

/**
 * A categorical colour per platform, from the theme-independent hue ramp in `app.css` (the avatar
 * palette) so the chart carries no raw colour of its own. The two platforms the gateway could not
 * name are muted grey: they are a residue, not a platform.
 */
const COLOURS: Record<string, string> = {
  web: 'var(--avatar-hue-3-from)',
  android: 'var(--avatar-hue-5-from)',
  ios: 'var(--avatar-hue-2-from)',
  macos: 'var(--avatar-hue-1-from)',
  windows: 'var(--avatar-hue-4-from)',
  linux: 'var(--avatar-hue-7-from)',
};

/** The colour a platform is drawn in; one the gateway invents later falls back to muted grey. */
export function platformColor(platform: string): string {
  return COLOURS[platform] ?? 'var(--text-muted)';
}

/** The localized name of a platform; an unfamiliar one is shown as the gateway spelled it. */
export function platformLabel(platform: string): string {
  switch (platform) {
    case 'web':
      return m.admin_status_platform_web();
    case 'android':
      return m.admin_status_platform_android();
    case 'ios':
      return m.admin_status_platform_ios();
    case 'macos':
      return m.admin_status_platform_macos();
    case 'windows':
      return m.admin_status_platform_windows();
    case 'linux':
      return m.admin_status_platform_linux();
    case 'other':
      return m.admin_status_platform_other();
    case 'unknown':
      return m.admin_status_platform_unknown();
    default:
      return platform;
  }
}

/** The localized form of a version string; the gateway's `unknown` / `other` are words, not versions. */
export function versionLabel(version: string): string {
  if (version === 'unknown') return m.admin_status_version_unknown();
  if (version === 'other') return m.admin_status_version_other();
  return version;
}
