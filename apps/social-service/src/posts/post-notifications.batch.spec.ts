/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import { PostNotificationsService } from './post-notifications.service';

/**
 * THE AGENDA'S NOTIFICATIONS ESCAPED THE ONE MAPPING THAT MAKES A PUSH TRANSLATABLE.
 *
 * `push-content.ts` exists because the services are the only layer that cannot know the recipient's
 * language: a push carries a KEY plus untranslatable data, and the device builds the sentence from
 * its own table. `PostNotificationsService.pushContent` is where a type is turned into that key.
 *
 * The association service wrote its event notifications straight to the repository and called
 * `push.notify` with a sentence it had composed itself - `Event "X" has been validated by the BDE.`
 * - so a French member got an English notification and no translation could reach it. It did that
 * to batch: the singular `createNotification` is one name lookup and one round trip per recipient,
 * and an association can have twenty proposers.
 *
 * So batching lives here now, and these pin that going around the mapping is no longer the fast
 * path. The five keys' native resources are pinned separately by
 * `frontend/src/lib/mobile/nativeStrings.test.ts`, which neither this file nor the service can see.
 */
describe('PostNotificationsService.createNotifications', () => {
  const saved: unknown[] = [];
  const pushes: { userId: string; content: { key: string; arg: string; actorName: string } }[] = [];
  let warn: jest.SpyInstance;

  function service(): PostNotificationsService {
    const notifRepo = {
      create: (row: unknown) => row,
      save: (rows: unknown) => {
        saved.push(...(Array.isArray(rows) ? rows : [rows]));
        return Promise.resolve(rows);
      },
      // `resolveActorName` reaches the users table through the repository's query runner.
      manager: { query: () => Promise.resolve([{ displayName: 'Claire' }]) },
    };
    const push = {
      notifyContent: (userId: string, content: { key: string; arg: string; actorName: string }) => {
        pushes.push({ userId, content });
        return Promise.resolve();
      },
    };
    return new PostNotificationsService(notifRepo as never, {} as never, push as never);
  }

  beforeEach(() => {
    saved.length = 0;
    pushes.length = 0;
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('writes one row per recipient in a single save', async () => {
    const written = await service().createNotifications({
      recipientIds: ['a', 'b', 'c'],
      type: 'event_proposed',
      postId: 'assoc-1',
      actorId: 'proposer',
      text: 'Soiree BDE',
      actorName: 'Claire',
    });

    expect(written).toBe(3);
    expect(saved).toHaveLength(3);
    expect(saved.map((r) => (r as { recipientId: string }).recipientId)).toEqual(['a', 'b', 'c']);
  });

  it('never notifies the actor about their own action', async () => {
    // The association's proposer list contains the proposer, and the BDE's validator list contains
    // whoever just validated. Filtering at the call sites is filtering in two places.
    const written = await service().createNotifications({
      recipientIds: ['a', 'proposer', 'b'],
      type: 'event_proposed',
      postId: 'assoc-1',
      actorId: 'proposer',
      text: 'Soiree BDE',
      actorName: 'Claire',
    });

    expect(written).toBe(2);
    expect(saved.map((r) => (r as { recipientId: string }).recipientId)).toEqual(['a', 'b']);
  });

  it('sends one notification to someone who is on the list twice', async () => {
    // A person can hold VALIDATE_EVENTS in more than one BDE association.
    await service().createNotifications({
      recipientIds: ['a', 'a', 'b'],
      type: 'event_proposed',
      postId: 'assoc-1',
      actorId: 'x',
      text: 'Soiree BDE',
      actorName: 'Claire',
    });

    expect(saved).toHaveLength(2);
    expect(pushes.map((p) => p.userId)).toEqual(['a', 'b']);
  });

  it('does nothing at all, and no lookup, when the list is empty after filtering', async () => {
    const written = await service().createNotifications({
      recipientIds: ['solo'],
      type: 'event_proposed',
      postId: 'assoc-1',
      actorId: 'solo',
      text: 'Soiree BDE',
    });

    expect(written).toBe(0);
    expect(saved).toHaveLength(0);
    expect(pushes).toHaveLength(0);
  });

  it.each([
    ['event_proposed', 'event_proposed'],
    ['event_validated', 'event_validated'],
    ['event_rejected', 'event_rejected'],
    ['event_updated', 'event_updated'],
    ['event_deleted', 'event_deleted'],
  ])('%s pushes a CONTENT KEY, never a composed sentence', async (type, expectedKey) => {
    await service().createNotifications({
      recipientIds: ['a'],
      type,
      postId: 'assoc-1',
      actorId: 'x',
      text: 'Soiree BDE',
      actorName: 'Claire',
    });

    expect(pushes).toHaveLength(1);
    expect(pushes[0].content.key).toBe(expectedKey);
    // The event's title travels as data, because a title is not translatable and a verb is.
    expect(pushes[0].content.arg).toBe('Soiree BDE');
    expect(warn).not.toHaveBeenCalled();
  });

  it('writes the in-app row but ACCUSES when a type has no push content', async () => {
    const written = await service().createNotifications({
      recipientIds: ['a'],
      type: 'event_postponed_maybe',
      postId: 'assoc-1',
      actorId: 'x',
      text: 'Soiree BDE',
      actorName: 'Claire',
    });

    // The row is still written - losing the notification would be worse than losing the push.
    expect(written).toBe(1);
    expect(pushes).toHaveLength(0);
    // And the log names the type, because a silent gap here is a notification class nobody misses.
    expect(String(warn.mock.calls[0][0])).toContain('event_postponed_maybe');
  });
});
