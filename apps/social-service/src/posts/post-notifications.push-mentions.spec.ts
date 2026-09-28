/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import { PostNotificationsService } from './post-notifications.service';
import { previewOf, type PushContent } from '../push/push-content';

/**
 * A POST'S NOTIFICATION SHOWED ITS SOURCE, NOT ITS TEXT (user, 2026-09-28).
 *
 * Two layers of it. The Markdown - `**`, `##` - reached the push and the app's list as typed: that
 * is `previewOf`, pinned in `push-content.spec.ts`. And a mention travelled as `@[` + 64 hex
 * characters: the app resolves those when it draws its list, but a phone's push handler has no name
 * directory and shows a social push's text as it arrives. These pin the second half: the STORED
 * row keeps the token for the app, the PUSH carries the name.
 */
describe('PostNotificationsService - mentions in a push', () => {
  const claire = 'c'.repeat(64);
  const ghost = 'd'.repeat(64);
  const saved: { text: string }[] = [];
  const pushes: PushContent[] = [];

  function service(): PostNotificationsService {
    const notifRepo = {
      create: (row: { text: string }) => row,
      save: (row: { text: string }) => {
        saved.push(row);
        return Promise.resolve(row);
      },
    };
    const postRepo = {
      manager: {
        query: (_sql: string, [id]: string[]) =>
          Promise.resolve(id === claire ? [{ displayName: 'Claire' }] : []),
      },
    };
    const push = {
      notifyContent: (_userId: string, content: PushContent) => {
        pushes.push(content);
        return Promise.resolve();
      },
    };
    return new PostNotificationsService(notifRepo as never, postRepo as never, push as never);
  }

  beforeEach(() => {
    saved.length = 0;
    pushes.length = 0;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('names a mentioned member in the push, and drops one it cannot name', async () => {
    expect(await service().renderMentionsForPush(`Merci @[${claire}] et @[${ghost}] !`)).toBe(
      'Merci @Claire et !'
    );
  });

  it('keeps the token in the stored row and sends the name in the push', async () => {
    const text = previewOf(`## Bravo **@[${claire}]** pour la soirée`);

    await service().createNotification({
      recipientId: 'reader',
      type: 'mention',
      postId: 'p-1',
      actorId: 'author',
      actorName: 'Léo',
      text,
    });

    expect(saved[0].text).toBe(`Bravo @[${claire}] pour la soirée`);
    expect(pushes[0].arg).toBe('Bravo @Claire pour la soirée');
  });

  it('leaves a text without mentions untouched', async () => {
    expect(await service().renderMentionsForPush('Soirée ce soir')).toBe('Soirée ce soir');
  });
});
