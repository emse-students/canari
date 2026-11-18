// @vitest-environment happy-dom
/**
 * A PREFERENCES ROW WITH A CONTROL stacks it under the text on a phone (Mi 9T, 2026-11-17): at a
 * doubled root font the beside-it shape left "Langue" one word per line and pushed the tour button
 * past the card. happy-dom has no layout, so the classes ARE the contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/posts/api', () => ({
  getRepostSettings: vi.fn().mockResolvedValue({ allowReposts: true }),
  setRepostSettings: vi.fn(),
  getActivitySettings: vi.fn().mockResolvedValue({ shareActivity: true }),
  setActivitySettings: vi.fn(),
}));

import SettingsPreferencesSection from './SettingsPreferencesSection.svelte';
import { m } from '$lib/paraglide/messages';

let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

async function render() {
  component = mount(SettingsPreferencesSection, { target: document.body });
  await tick();
  flushSync();
}

describe('preference rows with a control', () => {
  it('Language: the FR/EN control wraps under the label and fills the width on a phone', async () => {
    await render();
    const group = document.body.querySelector(
      `[role="radiogroup"][aria-label="${m.settings_language_label()}"]`
    ) as HTMLElement;
    expect(group).not.toBeNull();
    const row = group.parentElement!;
    expect(row.className).toContain('flex-col');
    expect(row.className).toContain('sm:flex-row');
    expect(group.className.split(' ')).toContain('w-full');
    expect(group.className.split(' ')).toContain('sm:w-auto');
  });

  it('Theme: the three segments share the control width and may wrap, so none runs off a doubled-font screen', async () => {
    await render();
    const group = document.body.querySelector(
      `[role="radiogroup"][aria-label="${m.profile_pref_theme_aria()}"]`
    ) as HTMLElement;
    expect(group).not.toBeNull();
    expect(group.parentElement!.className).toContain('flex-col');
    expect(group.className.split(' ')).toContain('w-full');
    expect(group.className.split(' ')).toContain('sm:w-auto');
    const segments = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      // `min-w-0` lets a flex item shrink below its text, `flex-1` shares the row equally.
      expect(segment.className.split(' ')).toContain('min-w-0');
      expect(segment.className.split(' ')).toContain('flex-1');
      expect(segment.querySelector('span')!.className).toContain('break-words');
    }
  });

  it('Guided tour: the replay button wraps under the label instead of squeezing it', async () => {
    await render();
    const button = document.body.querySelector('[data-guide-replay="welcome-tour"]') as HTMLElement;
    expect(button).not.toBeNull();
    const row = button.parentElement!;
    expect(row.className).toContain('flex-col');
    expect(row.className).toContain('sm:flex-row');
    expect(button.className.split(' ')).toContain('w-full');
    expect(button.className.split(' ')).toContain('sm:w-auto');
  });
});
