/// <reference types="jest" />

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { clientVersionAtLeast } from '../common/client-version';
import {
  CAMPUS_TREND_MIN_CLIENT_VERSION,
  HEADERLESS_CLIENT_VERSION,
  MIN_APP_VERSION_DATA_KEY,
  NOTIFICATION_TYPE_MIN_CLIENT,
  PUSH_KEY_MIN_CLIENT,
  notificationTypesRenderableBy,
} from './notification-client-floor';
import { PushService } from './push.service';
import { campusTrendContent, mentionContent, liveStartedContent } from './push-content';

/**
 * NEVER SEND A NOTIFICATION TO A CLIENT TOO OLD TO RENDER IT (owner, 2026-11-10). Two services and a
 * client hold the same fact - which build draws which type - and no compiler spans them, so this
 * reads the other two sides from source and fails on any disagreement. ADDING A TYPE WITHOUT ITS
 * FLOOR FAILS HERE (the client's set) or at compile time (`PushContentKey`, `NotificationType`).
 */
describe('the client floor of every notification type', () => {
  const repo = resolve(__dirname, '../../../..');
  const read = (path: string) => readFileSync(resolve(repo, path), 'utf8');

  /** `KNOWN_NOTIFICATION_TYPES` of the frontend: every bell type the CURRENT build draws. */
  const clientTypes = (() => {
    const source = read('frontend/src/lib/posts/notificationTarget.ts');
    const block = source.match(/KNOWN_NOTIFICATION_TYPES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
    if (!block) throw new Error('KNOWN_NOTIFICATION_TYPES not found in notificationTarget.ts');
    return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  })();

  it('reads the client set at all', () => {
    expect(clientTypes).toContain('comment');
    expect(clientTypes.length).toBeGreaterThan(20);
  });

  it('declares a floor for EVERY bell type the client draws, and for no other', () => {
    expect(Object.keys(NOTIFICATION_TYPE_MIN_CLIENT).sort()).toEqual(clientTypes);
  });

  it('declares a floor for every push key the union names', () => {
    const source = read('apps/social-service/src/push/push-content.ts');
    const union = source.match(/export type PushContentKey =([\s\S]*?);/);
    const keys = [...(union?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(keys.length).toBeGreaterThan(20);
    expect(Object.keys(PUSH_KEY_MIN_CLIENT).sort()).toEqual(keys);
  });

  it('writes every floor as a version, or null for what every admitted build draws', () => {
    const floors = [
      ...Object.values(NOTIFICATION_TYPE_MIN_CLIENT),
      ...Object.values(PUSH_KEY_MIN_CLIENT),
    ].filter((floor): floor is string => floor !== null);
    expect(floors.length).toBeGreaterThan(0);
    const unreadable = floors.filter((floor) => {
      try {
        clientVersionAtLeast('1.0.0', floor);
        return false;
      } catch {
        return true;
      }
    });
    expect(unreadable).toEqual([]);
  });

  it('puts the campus trend above every headerless build, on the row and on its three keys', () => {
    expect(clientVersionAtLeast(HEADERLESS_CLIENT_VERSION, CAMPUS_TREND_MIN_CLIENT_VERSION)).toBe(
      false
    );
    expect(NOTIFICATION_TYPE_MIN_CLIENT.campus_trend).toBe(CAMPUS_TREND_MIN_CLIENT_VERSION);
    for (const key of [
      'social_campus_trend',
      'social_campus_trend_photo',
      'social_campus_trend_video',
    ] as const) {
      expect(PUSH_KEY_MIN_CLIENT[key]).toBe(CAMPUS_TREND_MIN_CLIENT_VERSION);
    }
  });

  it('spells the push floor key as chat-delivery reads and strips it', () => {
    const source = read('apps/chat-delivery-service/src/utils/app-version.ts');
    expect(source).toContain(`MIN_APP_VERSION_DATA_KEY = '${MIN_APP_VERSION_DATA_KEY}'`);
  });
});

describe('notificationTypesRenderableBy', () => {
  it('serves a headerless read (a build up to 1.6.9) what it had, never a campus trend', () => {
    const types = notificationTypesRenderableBy(undefined);
    expect(types).toEqual(expect.arrayContaining(['comment', 'friend_reaction', 'birthday']));
    expect(types).not.toContain('campus_trend');
  });

  it('serves a 1.6.8 build neither 1.6.9 types nor the trend', () => {
    const types = notificationTypesRenderableBy('1.6.8');
    expect(types).toEqual(expect.arrayContaining(['member_repost', 'booking_changed']));
    for (const type of ['friend_reaction', 'birthday', 'event_open', 'campus_trend']) {
      expect(types).not.toContain(type);
    }
  });

  it('serves the trend to 1.6.10, a pre-release of it included', () => {
    expect(notificationTypesRenderableBy('1.6.10-alpha.1')).toContain('campus_trend');
    expect(notificationTypesRenderableBy('1.7.0')).toHaveLength(
      Object.keys(NOTIFICATION_TYPE_MIN_CLIENT).length
    );
  });

  it('serves an unreadable build only what every admitted build draws (fail closed)', () => {
    const everyBuild = Object.entries(NOTIFICATION_TYPE_MIN_CLIENT)
      .filter(([, floor]) => floor === null)
      .map(([type]) => type);
    expect(notificationTypesRenderableBy('latest')).toEqual(everyBuild);
  });
});

describe('PushService.notifyContent writes the key floor', () => {
  const sent = (content: Parameters<PushService['notifyContent']>[1], data = {}) => {
    const push = new PushService();
    const notify = jest.spyOn(push, 'notify').mockResolvedValue(undefined);
    return push.notifyContent('u1', content, data).then(() => notify.mock.calls[0][3]);
  };

  it('carries the floor of a key that has one', async () => {
    expect(await sent(campusTrendContent('Soirée', null))).toMatchObject({
      [MIN_APP_VERSION_DATA_KEY]: CAMPUS_TREND_MIN_CLIENT_VERSION,
    });
    expect(await sent(liveStartedContent('Ana', ''))).toMatchObject({
      [MIN_APP_VERSION_DATA_KEY]: '1.5.4',
    });
  });

  it('carries none for a key every admitted build composes', async () => {
    expect(await sent(mentionContent('Ana', 'hello'))).not.toHaveProperty(MIN_APP_VERSION_DATA_KEY);
  });

  it('cannot be lowered by a caller', async () => {
    expect(
      await sent(campusTrendContent('', 'photo'), { [MIN_APP_VERSION_DATA_KEY]: '0.0.1' })
    ).toMatchObject({ [MIN_APP_VERSION_DATA_KEY]: CAMPUS_TREND_MIN_CLIENT_VERSION });
  });
});

describe('campusTrendContent', () => {
  it('names the opening, or what the post shows, never a colon followed by nothing', () => {
    expect(campusTrendContent('Soirée jeux')).toMatchObject({
      key: 'social_campus_trend',
      arg: 'Soirée jeux',
      actorName: '',
      legacyTitle: 'Suggestion : Soirée jeux',
    });
    expect(campusTrendContent('', 'photo')).toMatchObject({
      key: 'social_campus_trend_photo',
      arg: '',
      legacyTitle: 'Suggestion : une photo',
    });
    expect(campusTrendContent('', 'video')).toMatchObject({
      key: 'social_campus_trend_video',
      legacyTitle: 'Suggestion : une vidéo',
    });
    expect(campusTrendContent('', null)).toMatchObject({
      key: 'social_campus_trend',
      arg: '',
      legacyTitle: 'Suggestion : une publication',
    });
    // Text wins over the media: the opening says more than "une photo".
    expect(campusTrendContent('Soirée', 'photo').key).toBe('social_campus_trend');
  });
});
