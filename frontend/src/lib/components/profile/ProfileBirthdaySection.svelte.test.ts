// @vitest-environment happy-dom
/**
 * THE BIRTHDAY SETTINGS (docs/wiki/birthdays.md): a new date counts from tomorrow and cannot change
 * again for 30 days. The form says so before the first save, locks the date while the server's
 * window is open (never learning it by a refusal), keeps who-sees-it and removal free, and meets a
 * second device's refusal by showing the server's state.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';

const api = vi.hoisted(() => ({
  fetchMyBirthday: vi.fn(),
  saveMyBirthday: vi.fn(),
  clearMyBirthday: vi.fn(),
}));
vi.mock('$lib/birthdays/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...api,
}));
const toasts = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('$lib/stores/toast.svelte', () => toasts);
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'me' }));

import ProfileBirthdaySection from './ProfileBirthdaySection.svelte';
import { m } from '$lib/paraglide/messages';

let component: ReturnType<typeof mount> | null = null;

async function settle() {
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

async function render() {
  component = mount(ProfileBirthdaySection, { target: document.body });
  await settle();
}

const select = (id: string) => document.getElementById(id) as HTMLSelectElement;
const opens = () => document.querySelector('[data-testid="birthday-change-opens"]');
const saveButton = () =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === m.profile_birthday_save()
  ) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

describe('the birthday settings', () => {
  it('says before the first save that a date counts from tomorrow and holds 30 days', async () => {
    api.fetchMyBirthday.mockResolvedValue({ birthday: null, changeOpensOn: null });
    await render();
    expect(document.body.textContent).toContain(m.profile_birthday_takes_effect());
    expect(opens()).toBeNull();
    expect(select('birthday-day').disabled).toBe(false);
    expect(select('birthday-month').disabled).toBe(false);
  });

  it('locks the date while the window is open, and keeps who-sees-it free', async () => {
    api.fetchMyBirthday.mockResolvedValue({
      birthday: { month: 5, day: 5, visibility: 'followers' },
      changeOpensOn: '2026-12-08',
    });
    await render();
    expect(opens()?.textContent).toContain('2026');
    expect(select('birthday-day').disabled).toBe(true);
    expect(select('birthday-month').disabled).toBe(true);
    const radios = [...document.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    expect(radios.every((r) => !r.disabled)).toBe(true);
  });

  it('meets a refusal from another device with its message and the server state', async () => {
    api.fetchMyBirthday.mockResolvedValueOnce({ birthday: null, changeOpensOn: null });
    await render();
    select('birthday-day').value = '6';
    select('birthday-day').dispatchEvent(new Event('change'));
    select('birthday-month').value = '5';
    select('birthday-month').dispatchEvent(new Event('change'));
    await settle();
    api.saveMyBirthday.mockRejectedValueOnce(
      new ApiRefusalError(409, 'BIRTHDAY_CHANGE_TOO_SOON', 'refused')
    );
    api.fetchMyBirthday.mockResolvedValueOnce({
      birthday: { month: 5, day: 5, visibility: 'followers' },
      changeOpensOn: '2026-12-08',
    });
    saveButton().click();
    await settle();
    expect(toasts.showToast).toHaveBeenCalledWith(m.profile_birthday_change_too_soon());
    expect(select('birthday-day').disabled).toBe(true);
    expect(opens()).not.toBeNull();
  });
});
