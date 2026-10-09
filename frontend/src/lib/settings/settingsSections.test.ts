import { describe, expect, it } from 'vitest';
import {
  SETTINGS_SECTIONS,
  parseSettingsSection,
  settingsHubRows,
  settingsSectionHref,
  settingsTrail,
} from './settingsSections';

describe('settings sections', () => {
  it('parses only known keys', () => {
    for (const key of SETTINGS_SECTIONS) expect(parseSettingsSection(key)).toBe(key);
    expect(parseSettingsSection('nope')).toBeNull();
    expect(parseSettingsSection('')).toBeNull();
    expect(parseSettingsSection(undefined)).toBeNull();
  });

  it('the hub lists every section once, the destructive one last and flagged', () => {
    const rows = settingsHubRows();
    expect(rows.map((r) => r.key)).toEqual([...SETTINGS_SECTIONS]);
    expect(rows.at(-1)?.tone).toBe('danger');
    expect(rows.filter((r) => r.tone === 'danger')).toHaveLength(1);
    for (const r of rows) expect(r.href).toBe(settingsSectionHref(r.key as never));
  });

  it('a section path goes back to the hub, one level', () => {
    const trail = settingsTrail('security', 'Settings');
    expect(trail).toHaveLength(2);
    expect(trail[0].href).toBe('/settings');
    expect(trail[1].href).toBe('/settings/security');
  });
});
