import type { Conversation } from '$lib/types';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import {
  drainDeferredWelcomeRequests,
  serveWelcomeRequest,
  type DeferredWelcomeRequest,
  type WelcomeRequestContext,
} from './welcomeRequestQueue';

vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

const GROUP = 'group-9f3ab210';
const ASKER: DeferredWelcomeRequest = {
  requesterUserId: 'user-asking',
  requesterDeviceId: 'dev-asking-01',
};

/** A conversation map in which `GROUP` is `pending` - the state that makes the responder defer. */
function notReady(): Map<string, Conversation> {
  return new Map([
    [
      GROUP,
      {
        id: GROUP,
        contactName: GROUP,
        name: 'Test',
        messages: [],
        lifecycle: 'pending',
        mlsStateHex: null,
      } as Conversation,
    ],
  ]);
}

/**
 * A context whose group EXISTS on the server and whose asker IS a member, so the responder reaches
 * its readiness guard and nothing earlier. `conversations` decides whether it defers.
 */
function makeContext(conversations: Map<string, Conversation>): WelcomeRequestContext & {
  lines: string[];
} {
  const lines: string[] = [];
  return {
    mlsService: createMlsServiceStub({
      getDeviceId: vi.fn().mockReturnValue('dev-me'),
      getGroupMeta: vi.fn().mockResolvedValue({ name: 'Test', isGroup: true }),
      getGroupUserMembers: vi.fn().mockResolvedValue([{ userId: ASKER.requesterUserId }]),
    }),
    storage: null,
    userId: 'user-me',
    deviceKeyB64: 'key',
    conversations,
    log: (m: string) => lines.push(m),
    deferred: new Map<string, DeferredWelcomeRequest[]>(),
    lines,
  };
}

/**
 * R-D9 - TWO ENTRANCES, ONE SERVED PATH, AND THE DEFERRAL IS PART OF IT.
 *
 * A device that has lost its MLS state asks the group's members to re-add it. The member that
 * answers must already hold a READY conversation for that group, so the responder has a third
 * outcome beside served and refused: NOT YET. The only correct thing to do with it is to remember
 * the asker and serve them when the group becomes ready.
 *
 * **That policy was written at one of the two entrances.** The socket entrance passed an
 * `onNotReady` that queued the asker; the queue's own drain passed none - and had already emptied
 * the queue - so an asker who was still too early on the drain fell into a `?.()` on an absent
 * callback and was dropped without a word. Nothing re-derived it; only the asker's own 60-second
 * retry brought it back.
 *
 * "Ready" here is the MLS group becoming sendable, which is NOT the same event as this device's
 * conversation row reaching `active` - one fire point in `setupMessageHandler` sets the row first
 * and the other does not - so a drain meeting a not-yet-ready group is a state the code reaches,
 * not a hypothetical.
 */
describe('a welcome_request is served one way, from either entrance (R-D9)', () => {
  const ENTRANCES = [
    {
      name: 'the socket - a welcome_request just arrived',
      enter: (ctx: WelcomeRequestContext) => serveWelcomeRequest(ctx, ASKER, GROUP),
    },
    {
      name: 'the drain - the group this asker was waiting on became ready',
      enter: (ctx: WelcomeRequestContext) => {
        ctx.deferred.set(GROUP, [ASKER]);
        return drainDeferredWelcomeRequests(ctx, GROUP);
      },
    },
  ];

  it('drives two distinct entrances, not one written twice', () => {
    expect(new Set(ENTRANCES.map((e) => e.enter.toString())).size).toBe(ENTRANCES.length);
  });

  for (const entrance of ENTRANCES) {
    it(`${entrance.name}: an asker the group is not ready for is QUEUED, never dropped`, async () => {
      const ctx = makeContext(notReady());

      await entrance.enter(ctx);

      // THE WHOLE DEFECT IN ONE ASSERTION. The drain used to consume the queue and pass no
      // `onNotReady`, so this map came back empty and the asker stayed locked out until they asked
      // again on their own.
      expect(ctx.deferred.get(GROUP)).toEqual([ASKER]);
      expect(ctx.lines.join(' | ')).toContain('not ready yet - deferred');
    });

    it(`${entrance.name}: a failure is reported, not swallowed`, async () => {
      const ctx = makeContext(notReady());
      // The responder's first server read. A throw here reaches the entrance, where one of the two
      // used to `.catch(() => {})` it into silence.
      ctx.mlsService.getGroupMeta = vi.fn().mockImplementation(() => {
        throw new Error('socket is gone');
      });

      // Never throws: one entrance is a WebSocket message handler and the other a group-ready
      // notification, and a rejection in either belongs to no group at all.
      await expect(entrance.enter(ctx)).resolves.toBeUndefined();
      expect(ctx.lines.join(' | ')).toMatch(/FAILED: socket is gone/);
    });
  }

  it('one asker waiting twice is one entry, however often they re-ask', async () => {
    const ctx = makeContext(notReady());

    // The refused device re-asks every 60 seconds. Without this, each ask that lands while the
    // group is still not ready adds another copy, and the drain then serves the same device N times.
    await serveWelcomeRequest(ctx, ASKER, GROUP);
    await serveWelcomeRequest(ctx, { ...ASKER }, GROUP);

    expect(ctx.deferred.get(GROUP)).toHaveLength(1);
    expect(ctx.lines.join(' | ')).toContain('is already waiting');
  });

  it('a SECOND device asking for the same group is a second waiter', async () => {
    const ctx = makeContext(notReady());
    const other = { requesterUserId: ASKER.requesterUserId, requesterDeviceId: 'dev-asking-02' };
    ctx.mlsService.getGroupUserMembers = vi
      .fn()
      .mockResolvedValue([{ userId: ASKER.requesterUserId }]);

    await serveWelcomeRequest(ctx, ASKER, GROUP);
    await serveWelcomeRequest(ctx, other, GROUP);

    // The identity is (userId, deviceId) and never userId alone: two devices of one user that have
    // both lost their state are two re-adds owed.
    expect(ctx.deferred.get(GROUP)).toEqual([ASKER, other]);
  });

  it('a drain with nobody waiting says nothing and does nothing', async () => {
    const ctx = makeContext(notReady());

    await drainDeferredWelcomeRequests(ctx, GROUP);

    expect(ctx.mlsService.getGroupMeta).not.toHaveBeenCalled();
    expect(ctx.lines).toEqual([]);
  });

  it('sessionAuth reaches the responder only through this module', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(
      join(process.cwd(), 'src', 'lib', 'composables', 'session', 'sessionAuth.ts'),
      'utf8'
    );

    // The duplicate was two hand-built parameter objects, one of them missing a field. A third
    // entrance that builds its own is the same defect again.
    expect(src).not.toContain('handleWelcomeRequest');
    expect(src).toContain('makeWelcomeRequestContext');
  });
});
