// @vitest-environment happy-dom
/**
 * THE OUTBOX'S MEDIA CALLS ARE BOUND TO THE ACCOUNT WHOSE OUTBOX IT IS (RC-13 review): the chat hold,
 * its release and a session release read the owner ONCE, when the deps are built. Read at call time,
 * an account switch in the middle of a drive held or released the first account's files under the
 * second's identity.
 */
import type { ChatSessionCallbacks, SessionContext } from './sessionTypes';

const asked = vi.hoisted(() => [] as string[]);
vi.mock('$lib/utils/chat/uploadReleaseMarks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/uploadReleaseMarks')>()),
  ownerBoundToken: (ownerId: string) => async () => `token of ${ownerId}`,
}));
vi.mock('$lib/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/media')>()),
  MediaService: class {
    async holdChatReel(mediaId: string, token: () => Promise<string>) {
      asked.push(`hold ${mediaId} with ${await token()}`);
      return 'held';
    }
    async releaseChatReel(mediaId: string, token: () => Promise<string>) {
      asked.push(`release ${mediaId} with ${await token()}`);
      return 'answered';
    }
  },
}));

const { makeOutboxDeps } = await import('./sessionAuth');

describe('makeOutboxDeps', () => {
  it('holds and releases a take file as the account it was built for, after a switch too', async () => {
    let user = 'user-a';
    const ctx = {
      getUserId: () => user,
      ensureMls: () => ({}),
      getStorage: () => null,
      getDeviceKey: () => 'key',
      isOfflineSession: () => false,
    } as unknown as SessionContext;
    const cb = {
      conversations: new Map(),
      log: () => undefined,
    } as unknown as ChatSessionCallbacks;
    const deps = makeOutboxDeps(ctx, cb);
    user = 'user-b';
    await deps.holdChatReel('m1');
    await deps.releaseChatReel('m1');
    expect(asked).toEqual(['hold m1 with token of user-a', 'release m1 with token of user-a']);
  });
});
