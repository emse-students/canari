// @vitest-environment happy-dom
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'u-me', deleteMyAccount: vi.fn() }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: {},
  appendLog: vi.fn(),
}));
vi.mock('$lib/stores/auth', () => ({ clearAuth: vi.fn(), leaveSignedOut: vi.fn() }));

import SettingsDangerZone from './SettingsDangerZone.svelte';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The field slides in, and the teardown cancels that animation.
afterAll(adoptTransitionAnimations());

let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) void unmount(component);
  component = null;
  document.body.innerHTML = '';
});

describe('the account deletion field', () => {
  it('is named by the prompt shown above it, not by its placeholder', () => {
    component = mount(SettingsDangerZone, { target: document.body });
    flushSync();
    document.querySelector<HTMLButtonElement>('button')!.click();
    flushSync();

    const field = document.querySelector<HTMLInputElement>('input[type="text"]')!;
    const named = document.getElementById(field.getAttribute('aria-labelledby')!);

    expect(named?.textContent?.trim()).toBe(
      m.profile_delete_type_prompt({ word: m.profile_delete_confirm_word() })
    );
    expect(field.hasAttribute('aria-label')).toBe(false);
  });
});
