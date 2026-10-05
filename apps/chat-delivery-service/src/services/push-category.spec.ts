/// <reference types="jest" />

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
    ['form_opening_soon', 'forms'],
    ['form_open', 'forms'],
    ['event_proposed', 'events'],
    ['event_validated', 'events'],
    ['event_rejected', 'events'],
    ['event_updated', 'events'],
    ['event_deleted', 'events'],
    ['event_pending', 'events'],
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

  it('never files an explicitly silent frame, whatever it is', () => {
    expect(categoryOfDataPush({ type: 'channel', silent: 'true' })).toBeNull();
  });

  it('knows exactly the ids it lists', () => {
    for (const id of NOTIFICATION_CATEGORIES) expect(isNotificationCategory(id)).toBe(true);
    expect(isNotificationCategory('calls')).toBe(false);
    expect(isNotificationCategory(undefined)).toBe(false);
  });
});
