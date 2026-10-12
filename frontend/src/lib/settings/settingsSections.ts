/**
 * THE SECTIONS OF THE ACCOUNT SETTINGS, AS ROUTE SEGMENTS (`/settings/<section>`).
 *
 * `/settings` used to be one long page stacking eight cards, so reaching "Blocked people" meant
 * scrolling past six others. It is now a hub of rows like every other menu of the app (user,
 * 2026-10-08: "on navigue en profondeur"), and each card is a page of its own under a breadcrumb.
 * The segment is user input, so an unknown one is sent back to the hub by the route loader.
 *
 * Every section is open to any signed-in reader: there is no permission table here, only the one
 * list the hub, the loader and the trail all read.
 */
import type { Component } from 'svelte';
import { Ban, Bell, HardDrive, Info, RefreshCw, Settings, Shield, Trash2 } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { Crumb, HubRow } from '$lib/components/navigation/breadcrumb';

/** The section keys, in hub order. The destructive one stays last. */
export const SETTINGS_SECTIONS = [
  'preferences',
  'notifications',
  'security',
  'backup',
  'blocked',
  'about',
  'storage',
  'danger',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

interface SettingsEntry {
  label: () => string;
  icon: Component<{ size?: number }>;
  tone?: HubRow['tone'];
}

/** Each label is the heading the section's own card already carries, so a name exists once. */
const ENTRIES: Record<SettingsSection, SettingsEntry> = {
  preferences: { label: () => m.profile_preferences_title(), icon: Settings },
  notifications: { label: () => m.settings_notifications_heading(), icon: Bell },
  security: { label: () => m.profile_security_heading(), icon: Shield },
  backup: { label: () => m.profile_backup_heading(), icon: RefreshCw },
  blocked: { label: () => m.settings_blocked_heading(), icon: Ban },
  about: { label: () => m.settings_about_heading(), icon: Info },
  storage: { label: () => m.settings_storage_heading(), icon: HardDrive },
  danger: { label: () => m.profile_delete_heading(), icon: Trash2, tone: 'danger' },
};

/** Narrows an untrusted string (a URL segment) to a section key. */
export function parseSettingsSection(value: string | null | undefined): SettingsSection | null {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value ?? '')
    ? (value as SettingsSection)
    : null;
}

/** The localized name of a section: its row, its crumb and its tab title. */
export function settingsSectionLabel(section: SettingsSection): string {
  return ENTRIES[section].label();
}

/** The route of the hub (no section) or of one section. */
export function settingsSectionHref(section?: SettingsSection | null): string {
  return section ? `/settings/${section}` : '/settings';
}

/** The hub's rows, in order. */
export function settingsHubRows(): HubRow[] {
  return SETTINGS_SECTIONS.map((key) => ({
    key,
    href: settingsSectionHref(key),
    label: ENTRIES[key].label(),
    icon: ENTRIES[key].icon,
    tone: ENTRIES[key].tone,
  }));
}

/**
 * The path above a section: Settings > Section. Back is the previous crumb, so this function IS
 * the back behaviour of the level; the hub itself has no trail (it is a top-level menu).
 */
export function settingsTrail(section: SettingsSection, rootLabel: string): Crumb[] {
  return [
    { label: rootLabel, href: settingsSectionHref() },
    { label: ENTRIES[section].label(), href: settingsSectionHref(section) },
  ];
}
