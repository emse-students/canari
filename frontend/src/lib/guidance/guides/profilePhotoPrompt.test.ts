/**
 * THE PROFILE-PHOTO PROMPT (owner, 2026-11-07): no photo and never shown -> the invitation; shown
 * less than 30 days ago -> nothing; 30 days or more and still no photo -> ONE reminder; reminder
 * shown -> never; a photo -> never. The rule is a pure function of server-measured facts, then
 * driven through the real engine to pin that the action button records the help.
 */
import { describe, expect, it, vi } from 'vitest';
import { GuideEngine, type GuideEnvironment } from '../guideEngine.svelte';
import type { HelpId } from '../helpIds';
import { GUIDES } from './index';
import {
  PROFILE_PHOTO_REMINDER_AFTER_SECONDS as THIRTY_DAYS,
  profilePhotoPromptStage,
} from './profilePhotoPromptStage';

vi.mock('$lib/utils/Log', () => ({ Log: { d: () => {}, i: () => {} } }));
const openProfilePhotoPage = vi.fn(() => {});
vi.mock('$lib/utils/profilePhotoLink', () => ({
  openProfilePhotoPage: () => openProfilePhotoPage(),
}));

const base = {
  eligible: true,
  hasPhoto: false,
  firstSeen: false,
  reminderSeen: false,
  firstAgeSeconds: null,
  month: 11,
};

describe('profilePhotoPromptStage', () => {
  it('invites an account with no photo that was never shown it', () => {
    expect(profilePhotoPromptStage(base)).toBe('first');
  });

  it('waits while the first showing is under 30 days old', () => {
    for (const age of [0, 3600, THIRTY_DAYS - 1]) {
      expect(
        profilePhotoPromptStage({ ...base, firstSeen: true, firstAgeSeconds: age })
      ).toBeNull();
    }
  });

  it('reminds ONCE from 30 days on, while there is still no photo', () => {
    for (const age of [THIRTY_DAYS, THIRTY_DAYS + 1, THIRTY_DAYS * 10]) {
      expect(profilePhotoPromptStage({ ...base, firstSeen: true, firstAgeSeconds: age })).toBe(
        'reminder'
      );
    }
  });

  it('never shows anything once the reminder was shown', () => {
    expect(
      profilePhotoPromptStage({
        ...base,
        firstSeen: true,
        reminderSeen: true,
        firstAgeSeconds: THIRTY_DAYS * 12,
      })
    ).toBeNull();
  });

  it('never shows anything to an account that has a photo, or when nobody could say', () => {
    for (const hasPhoto of [true, null]) {
      expect(profilePhotoPromptStage({ ...base, hasPhoto })).toBeNull();
      expect(
        profilePhotoPromptStage({
          ...base,
          hasPhoto,
          firstSeen: true,
          firstAgeSeconds: THIRTY_DAYS * 2,
        })
      ).toBeNull();
    }
  });

  it('shows nothing in September, the first prompt or the reminder, and resumes in October', () => {
    expect(profilePhotoPromptStage({ ...base, month: 9 })).toBeNull();
    expect(
      profilePhotoPromptStage({ ...base, firstSeen: true, firstAgeSeconds: THIRTY_DAYS, month: 9 })
    ).toBeNull();
    expect(profilePhotoPromptStage({ ...base, month: 10 })).toBe('first');
    expect(profilePhotoPromptStage({ ...base, month: 8 })).toBe('first');
  });

  it('shows nothing to an account the server does not offer it to, first or reminder', () => {
    expect(profilePhotoPromptStage({ ...base, eligible: false })).toBeNull();
    expect(
      profilePhotoPromptStage({
        ...base,
        eligible: false,
        firstSeen: true,
        firstAgeSeconds: THIRTY_DAYS,
      })
    ).toBeNull();
  });

  it('does not guess an age the server has not given (first showing still owed)', () => {
    expect(profilePhotoPromptStage({ ...base, firstSeen: true, firstAgeSeconds: null })).toBeNull();
  });
});

describe('the two declared helps', () => {
  const first = GUIDES.find((g) => g.id === 'prompt-profile-photo')!;
  const reminder = GUIDES.find((g) => g.id === 'prompt-profile-photo-reminder')!;

  it('are declared right after the welcome tour, on the feed, as a centred card with an action', () => {
    expect(GUIDES.slice(0, 3).map((g) => g.id)).toEqual([
      'welcome-tour',
      'prompt-profile-photo',
      'prompt-profile-photo-reminder',
    ]);
    for (const g of [first, reminder]) {
      expect(g.appliesTo('/posts')).toBe(true);
      expect(g.appliesTo('/chat')).toBe(false);
      expect(g.steps).toHaveLength(1);
      expect(g.steps[0].anchor).toBeNull();
      expect(g.steps[0].action).toBeDefined();
      expect(g.replay).toBeUndefined();
    }
  });

  it('start through the real engine, and the button opens the gallery and records the help', () => {
    const seen = new Set<HelpId>(['welcome-tour']);
    const env: GuideEnvironment = {
      layout: () => ({ phone: true, swipe: true, nativeTabBar: false }),
      isAnchorRendered: () => true,
      isSeen: (id) => seen.has(id),
      seenReady: () => true,
      markSeen: (id) => void seen.add(id),
      situation: () => '/posts#0',
    };
    // The module's `eligible` reads the app's stores, which say "unknown" here: made eligible by
    // declarations that keep their steps and add the answer, so the ENGINE path is what is tested.
    const engine = new GuideEngine([{ ...first, eligible: () => true }], env);
    engine.consider(true, '/posts');
    expect(engine.activeId).toBe('prompt-profile-photo');
    expect(engine.view?.step.action).toBeDefined();
    engine.act();
    expect(openProfilePhotoPage).toHaveBeenCalledTimes(1);
    expect(engine.activeId).toBeNull();
    expect(seen.has('prompt-profile-photo')).toBe(true);
    engine.consider(true, '/posts');
    expect(engine.activeId).toBeNull();
  });

  it('are not offered while the app has no photo answer (eligible is false)', () => {
    expect(first.eligible?.()).toBe(false);
    expect(reminder.eligible?.()).toBe(false);
  });
});
