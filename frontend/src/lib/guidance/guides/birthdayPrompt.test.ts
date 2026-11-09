/**
 * THE BIRTHDAY PROMPT (docs/wiki/birthdays.md): ONE card on the feed, to an account the server says
 * has no birthday, never when it has one or when nobody could say; its button opens Profile >
 * Anniversaire and records the help, which is never shown again (no reminder, by design).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GuideEngine, type GuideEnvironment } from '../guideEngine.svelte';
import type { HelpId } from '../helpIds';
import { GUIDES } from './index';

vi.mock('$lib/utils/Log', () => ({ Log: { d: () => {}, i: () => {} } }));
const nav = vi.hoisted(() => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock('$app/navigation', () => nav);
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

import { birthdayPrompt } from './birthdayPrompt';
import { OwnBirthdayFact, ownBirthday } from '$lib/birthdays/birthdaysToday.svelte';

describe('the birthday prompt', () => {
  beforeEach(() => nav.goto.mockClear());

  it('is declared after the profile-photo prompts, on the feed, as a centred card with an action', () => {
    const ids = GUIDES.map((g) => g.id);
    expect(ids).toContain('prompt-birthday');
    expect(ids.indexOf('prompt-birthday')).toBeGreaterThan(
      ids.indexOf('prompt-profile-photo-reminder')
    );
    expect(birthdayPrompt.appliesTo('/posts')).toBe(true);
    expect(birthdayPrompt.appliesTo('/chat')).toBe(false);
    expect(birthdayPrompt.steps).toHaveLength(1);
    expect(birthdayPrompt.steps[0].anchor).toBeNull();
    expect(birthdayPrompt.replay).toBeUndefined();
  });

  it('is offered only to an account the server says has no birthday', () => {
    expect(birthdayPrompt.eligible?.()).toBe(false); // unknown: nothing
    ownBirthday.set('me', true);
    expect(birthdayPrompt.eligible?.()).toBe(false);
    ownBirthday.set('me', false);
    expect(birthdayPrompt.eligible?.()).toBe(true);
    // Another account's fact is never read.
    const fresh = new OwnBirthdayFact();
    expect(fresh.hasBirthday).toBeNull();
  });

  it('starts through the real engine, opens the birthday section and is never shown again', () => {
    const seen = new Set<HelpId>(['welcome-tour']);
    const env: GuideEnvironment = {
      layout: () => ({ phone: true, swipe: true, nativeTabBar: false }),
      isAnchorRendered: () => true,
      isSeen: (id) => seen.has(id),
      seenReady: () => true,
      markSeen: (id) => void seen.add(id),
      situation: () => '/posts#0',
    };
    const engine = new GuideEngine([{ ...birthdayPrompt, eligible: () => true }], env);
    engine.consider(true, '/posts');
    expect(engine.activeId).toBe('prompt-birthday');
    engine.act();
    expect(nav.goto).toHaveBeenCalledWith('profile/me/birthday');
    expect(seen.has('prompt-birthday')).toBe(true);
    engine.consider(true, '/posts');
    expect(engine.activeId).toBeNull();
  });
});
