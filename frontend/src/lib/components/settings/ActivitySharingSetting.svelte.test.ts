// @vitest-environment happy-dom
/**
 * "PARTAGER MON ACTIVITE" (engagement decision 9, WP-9): the switch shows the server's answer, ON
 * when no choice was ever made, writes the flip, and comes back with a toast when the write fails.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

const api = vi.hoisted(() => ({
  getActivitySettings: vi.fn(),
  setActivitySettings: vi.fn(),
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('$lib/posts/api', () => api);
vi.mock('$lib/stores/toast.svelte', () => toast);

import ActivitySharingSetting from './ActivitySharingSetting.svelte';
import { m } from '$lib/paraglide/messages';

let component: ReturnType<typeof mount> | null = null;

async function settle() {
  for (let i = 0; i < 5; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

async function render() {
  component = mount(ActivitySharingSetting, { target: document.body });
  await settle();
}

const switchEl = () =>
  document.querySelector<HTMLButtonElement>(
    '[data-activity-sharing-setting] button[role="switch"]'
  );
/** What the switch draws: its aria-checked state. */
const drawn = () => switchEl()?.getAttribute('aria-checked');

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

describe('ActivitySharingSetting', () => {
  it('draws nothing until the server answered, then its answer', async () => {
    api.getActivitySettings.mockResolvedValue({ shareActivity: true });
    await render();
    expect(drawn()).toBe('true');
    expect(document.body.textContent).toContain(m.settings_share_activity());
    // Row layout shared with its neighbours: icon tile first, the switch last (on the right).
    const row = document.querySelector('[data-activity-sharing-setting] > div')!;
    expect(row.firstElementChild?.querySelector('svg')).not.toBeNull();
    expect(row.lastElementChild).toBe(switchEl());
  });

  it('writes the flip and draws what the server stored', async () => {
    api.getActivitySettings.mockResolvedValue({ shareActivity: true });
    api.setActivitySettings.mockResolvedValue({ shareActivity: false });
    await render();
    switchEl()!.click();
    await settle();
    expect(api.setActivitySettings).toHaveBeenCalledWith(false);
    expect(drawn()).toBe('false');
  });

  it('keeps the old state and says so when the write fails', async () => {
    api.getActivitySettings.mockResolvedValue({ shareActivity: false });
    api.setActivitySettings.mockRejectedValue(new Error('down'));
    await render();
    switchEl()!.click();
    await settle();
    expect(drawn()).toBe('false');
    expect(toast.showToast).toHaveBeenCalledWith(m.settings_share_activity_error(), 'error');
  });
});
