// @vitest-environment happy-dom
/**
 * THE BIRTHDAY RING (decision 3, docs/wiki/birthdays.md) is drawn by the ONE avatar component for a
 * member the server names as celebrated today - photo or initials, any size - and for nobody else;
 * a sign-out takes it away. The set is the server's answer: the client never decides "today".
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

const api = vi.hoisted(() => ({ fetchBirthdaysToday: vi.fn(), fetchMyBirthday: vi.fn() }));
vi.mock('$lib/birthdays/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...api,
}));
const faces = vi.hoisted(() => ({
  resolveUserAvatarDisplay: vi.fn(),
  releaseUserAvatarDisplay: vi.fn(),
}));
vi.mock('$lib/utils/userAvatarCache', () => faces);
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => id.toUpperCase(),
  resolveUserDisplayName: (id: string) => Promise.resolve(id.toUpperCase()),
}));

import Avatar from './Avatar.svelte';
import { birthdaysToday } from '$lib/birthdays/birthdaysToday.svelte';

let component: ReturnType<typeof mount> | null = null;

async function settle() {
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

async function render(userId: string) {
  component = mount(Avatar, { target: document.body, props: { userId, size: 'sm' } });
  await settle();
}

const ringed = () => document.querySelectorAll('.birthday-ring').length;

beforeEach(async () => {
  vi.clearAllMocks();
  faces.resolveUserAvatarDisplay.mockResolvedValue({ kind: 'none' });
  api.fetchBirthdaysToday.mockResolvedValue({ date: '2026-11-08', userIds: ['ann'] });
  await birthdaysToday.refresh('me');
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  birthdaysToday.clear();
  document.body.innerHTML = '';
});

describe('the birthday ring on the shared avatar', () => {
  it('rings the initials of a member celebrated today', async () => {
    await render('ann');
    expect(ringed()).toBe(1);
  });

  it('rings the photo of a member celebrated today', async () => {
    faces.resolveUserAvatarDisplay.mockResolvedValue({ kind: 'direct', url: '/a.jpg' });
    await render('ann');
    expect(document.querySelector('[data-birthday="today"]')).not.toBeNull();
    expect(ringed()).toBe(1);
  });

  it('draws no ring for anybody else, nor for an absent user', async () => {
    await render('bob');
    expect(ringed()).toBe(0);
    if (component) unmount(component);
    await render('');
    expect(ringed()).toBe(0);
  });

  it('takes the ring away when the account signs out', async () => {
    await render('ann');
    expect(ringed()).toBe(1);
    birthdaysToday.clear();
    await settle();
    expect(ringed()).toBe(0);
  });

  it('keeps the last answer when the server cannot be asked, and never invents one', async () => {
    api.fetchBirthdaysToday.mockRejectedValueOnce(new Error('offline'));
    await birthdaysToday.refresh('me');
    await render('ann');
    expect(ringed()).toBe(1);
    // Another account: the previous answer is never read.
    api.fetchBirthdaysToday.mockRejectedValueOnce(new Error('offline'));
    await birthdaysToday.refresh('other');
    await settle();
    expect(ringed()).toBe(0);
  });
});

/** The wrapper's measured width, which happy-dom cannot compute: read from the size class. */
let measured = 24;
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get() {
    return measured;
  },
});

describe('the ring is outside the face and the confetti is deterministic', () => {
  it('wraps the clipped face, with the ring and the confetti OUTSIDE the clip', async () => {
    await render('ann');
    const wrap = document.querySelector('[data-birthday="today"]') as HTMLElement;
    expect(wrap.classList.contains('avatar-wrap')).toBe(true);
    const ring = wrap.querySelector('.birthday-ring') as HTMLElement;
    expect(ring.closest('.overflow-hidden')).toBeNull();
    // Five dots at the 24 px of `sm` (under 30 px), none inside the clipped face.
    const pieces = wrap.querySelectorAll('[data-confetti]');
    expect(pieces.length).toBe(5);
    for (const piece of pieces) expect(piece.closest('.overflow-hidden')).toBeNull();
  });

  it('draws the same confetti every time', async () => {
    await render('ann');
    const first = document.querySelector('.avatar-wrap')?.innerHTML;
    unmount(component!);
    await render('ann');
    expect(document.querySelector('.avatar-wrap')?.innerHTML).toBe(first);
  });

  it('keeps the avatar box: the wrapper carries the size, not the face', async () => {
    await render('ann');
    expect(document.querySelector('.avatar-wrap')?.className).toContain('w-6');
  });

  it('draws no confetti until the box has been measured, so the pieces never jump', async () => {
    measured = 0;
    await render('ann');
    expect(document.querySelectorAll('[data-confetti]').length).toBe(0);
    expect(ringed()).toBe(1);
    measured = 24;
  });

  it('draws the count of the measured size: 12 at 56 px', async () => {
    measured = 56;
    await render('ann');
    expect(document.querySelectorAll('[data-confetti]').length).toBe(12);
    measured = 24;
  });

  it('positions the initials face too, or the ring would paint over it', async () => {
    await render('ann');
    const face = document.querySelector('.avatar-wrap .avatar-placeholder') as HTMLElement;
    expect(face.className).toContain('relative');
  });

  it('gives the ring the squircle corner for a soft avatar, on the photo branch too', async () => {
    faces.resolveUserAvatarDisplay.mockResolvedValue({ kind: 'direct', url: '/a.jpg' });
    component = mount(Avatar, {
      target: document.body,
      props: { userId: 'ann', size: 'sm', shape: 'soft' },
    });
    await settle();
    expect(document.querySelector('.birthday-ring')?.className).toContain('squircle');
    expect(document.querySelector('.avatar-wrap img')).not.toBeNull();
  });

  it('keeps the SAME face node when the member starts celebrating at runtime', async () => {
    faces.resolveUserAvatarDisplay.mockResolvedValue({ kind: 'direct', url: '/a.jpg' });
    api.fetchBirthdaysToday.mockResolvedValue({ date: '2026-11-08', userIds: [] });
    await birthdaysToday.refresh('me');
    await render('ann');
    const img = document.querySelector('.avatar-wrap img');
    expect(img).not.toBeNull();
    expect(ringed()).toBe(0);
    api.fetchBirthdaysToday.mockResolvedValue({ date: '2026-11-08', userIds: ['ann'] });
    await birthdaysToday.refresh('me');
    await settle();
    expect(ringed()).toBe(1);
    expect(document.querySelector('.avatar-wrap img')).toBe(img);
  });
});
