/// <reference types="jest" />

import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  categoryOfDataPush,
  isNotificationCategory,
  NOTIFICATION_CATEGORIES,
} from './push-category';

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
    ['social_repost_proposed', 'posts'],
    ['social_repost_personal_requested', 'posts'],
    ['social_coorganise_proposed', 'events'],
    ['social_live_started', 'posts'],
    ['social_follow_request', 'follows'],
    ['social_follow_accepted', 'follows'],
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
    ['social_booking_cancelled', 'bookings'],
    ['social_booking_withdrawn', 'bookings'],
    ['social_booking_added', 'bookings'],
    ['social_booking_reminder', 'bookings'],
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
      declared.filter((k) => k.startsWith('social_live_') && k !== 'social_live_started')
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
