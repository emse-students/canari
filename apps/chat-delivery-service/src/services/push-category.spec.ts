/// <reference types="jest" />

import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  CATEGORY_MIN_CLIENT,
  categoriesNameableBy,
  categoryOfDataPush,
  isNotificationCategory,
  NOTIFICATION_CATEGORIES,
} from './push-category';
import { appVersionAtLeast, HEADERLESS_CLIENT_VERSION } from '../utils/app-version';

/**
 * The map from a push's own fields to the switch that governs it. Every kind of server push that
 * exists is listed here, so adding one without filing it is a visible choice and not an accident.
 */
describe('categoryOfDataPush', () => {
  it.each([
    ['social_mention', 'mentions'],
    ['social_reply', 'comments'],
    ['social_comment', 'comments'],
    ['social_reaction', 'reactions'],
    ['social_association_post', 'posts'],
    ['social_followed_post', 'posts'],
    ['social_association_repost', 'posts'],
    ['social_member_repost', 'posts'],
    ['social_repost_proposed', 'posts'],
    ['social_repost_personal_requested', 'posts'],
    ['social_coorganise_proposed', 'events'],
    ['social_live_started', 'posts'],
    ['social_friend_reaction', 'posts'],
    ['social_friend_comment', 'posts'],
    // A campus trend is a suggestion, its own switch independent of posts (owner, 2026-11-10).
    ['social_campus_trend', 'suggestions'],
    ['social_campus_trend_photo', 'suggestions'],
    ['social_campus_trend_video', 'suggestions'],
    ['social_live_mention', 'mentions'],
    ['social_follow_request', 'follows'],
    ['social_follow_accepted', 'follows'],
    ['social_birthday', 'birthdays'],
    ['chat_join_ask', 'messages'],
    ['form_opening_soon', 'forms'],
    ['form_open', 'forms'],
    ['form_paid_over_capacity', 'forms'],
    ['lydia_payments_active', 'forms'],
    ['lydia_payments_paused', 'forms'],
    ['lydia_refund_issued', 'forms'],
    ['event_proposed', 'events'],
    ['event_validated', 'events'],
    ['event_rejected', 'events'],
    ['event_updated', 'events'],
    ['event_deleted', 'events'],
    ['event_pending', 'events'],
    ['event_pending_coorganiser', 'events'],
    ['social_booking_cancelled', 'bookings'],
    ['social_booking_withdrawn', 'bookings'],
    ['social_booking_added', 'bookings'],
    ['social_booking_reminder', 'bookings'],
    ['social_booking_changed', 'bookings'],
    ['social_booking_removed', 'bookings'],
    ['social_booking_open', 'bookings'],
    ['social_event_open', 'events'],
  ])('files contentKey %s under %s', (contentKey, expected) => {
    expect(categoryOfDataPush({ type: 'social', contentKey })).toBe(expected);
  });

  it('files a community salon message under channels', () => {
    expect(categoryOfDataPush({ type: 'channel', channelId: 'c1', mentioned: 'true' })).toBe(
      'channels'
    );
  });

  it('files a direct-message reaction under reactions', () => {
    expect(categoryOfDataPush({ type: 'social', reaction: 'true', groupId: 'g' })).toBe(
      'reactions'
    );
  });

  it('files the legacy form reminder type under forms', () => {
    expect(categoryOfDataPush({ type: 'form_reminder' })).toBe('forms');
  });

  it.each(['channel_read', 'call_ring', 'call_ring_end', 'welcome_request', 'device_revoked'])(
    'never files %s: it must always go out',
    (type) => {
      expect(categoryOfDataPush({ type })).toBeNull();
    }
  );

  /**
   * The live moderation keys, as social-service SENDS them: read out of its `PushContentKey` union
   * (the service boundary has no shared import), so a key renamed or misspelled there fails here
   * rather than reaching a category by accident.
   */
  const LIVE_MODERATION_KEYS = [
    'social_live_cut',
    'social_live_suspended',
    'social_live_withdrawn',
  ];

  it('names the live moderation keys exactly as social-service declares them', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../social-service/src/push/push-content.ts'),
      'utf8'
    );
    const union = source.match(/export type PushContentKey =([\s\S]*?);/);
    const declared = [...(union?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(
      declared.filter(
        (k) =>
          k.startsWith('social_live_') && k !== 'social_live_started' && k !== 'social_live_mention'
      )
    ).toEqual(LIVE_MODERATION_KEYS);
  });

  it.each(LIVE_MODERATION_KEYS)(
    'never files %s: a sanction on the reader own account always goes out',
    (contentKey) => {
      expect(categoryOfDataPush({ type: 'social', contentKey })).toBeNull();
    }
  );

  it('never files an explicitly silent frame, whatever it is', () => {
    expect(categoryOfDataPush({ type: 'channel', silent: 'true' })).toBeNull();
  });

  it('knows exactly the ids it lists', () => {
    for (const id of NOTIFICATION_CATEGORIES) expect(isNotificationCategory(id)).toBe(true);
    expect(isNotificationCategory('calls')).toBe(false);
    expect(isNotificationCategory(undefined)).toBe(false);
  });
});

/**
 * THE FLOOR OF EVERY CATEGORY: a save from a build that cannot name a category keeps its stored
 * choice. A new category whose floor does not sit above every headerless build would let a `1.6.9`
 * phone's save switch it back on - so the table is pinned here.
 */
describe('CATEGORY_MIN_CLIENT', () => {
  it('declares a floor for every category and for no other', () => {
    expect(Object.keys(CATEGORY_MIN_CLIENT).sort()).toEqual([...NOTIFICATION_CATEGORIES].sort());
  });

  it('writes every floor as a version or null', () => {
    const unreadable = Object.values(CATEGORY_MIN_CLIENT).filter(
      (floor) => floor !== null && appVersionAtLeast('1.0.0', floor) === null
    );
    expect(unreadable).toEqual([]);
  });

  it('puts suggestions above every headerless build, and lets 1.6.10 name everything', () => {
    expect(appVersionAtLeast(HEADERLESS_CLIENT_VERSION, CATEGORY_MIN_CLIENT.suggestions!)).toBe(
      false
    );
    expect(categoriesNameableBy(undefined)).not.toContain('suggestions');
    expect(categoriesNameableBy('1.6.10')).toEqual([...NOTIFICATION_CATEGORIES]);
  });

  it('names for each build what its settings screen drew (read from the release tags)', () => {
    expect(categoriesNameableBy('1.5.0')).toEqual([
      'messages',
      'channels',
      'posts',
      'comments',
      'mentions',
      'reactions',
      'events',
      'forms',
    ]);
    expect(categoriesNameableBy('1.6.8')).not.toContain('birthdays');
    expect(categoriesNameableBy('1.6.9')).toContain('birthdays');
  });
});
