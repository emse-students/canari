/**
 * HOLDS on a shared reel file (reels-in-chat 15.3-15.5, 15.7; RC-14): one take published on
 * CanaReels AND sent to conversations is ONE stored file, kept while ANY hold remains.
 *
 * Pinned, each because the opposite is a plausible mistake:
 *  - a published-and-sent file survives its post's AUTHOR delete and its post's retention, lives on
 *    its chat hold alone, and goes with the last hold - never by either clock alone;
 *  - it survives its 30-day chat hold while the post holds it;
 *  - a MODERATION purge (feed or salon) ends every hold at once, and every later reader gets `410`;
 *  - a `reel-pending` the take holds is not swept at 24 h, and moves to `chat-reel` (the rollback
 *    hazard: an older build sweeps `reel-pending` at 24 h, `chat-reel` at 30 days);
 *  - the hold route is owner-only, idempotent, charged once against the daily budget;
 *  - the sender's delete releases ITS hold, and the file only when it was the last;
 *  - the salon purge's allowlist: the row's author must be the uploader, and a chat hold must exist.
 */
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { CHAT_REEL_OVER_BUDGET, MediaService } from './media.service';

const ALICE = 'alice';
const BOB = 'bob';
const FILE = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const PENDING = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const CHAT_ONLY = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';
const FEED_ONLY = '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d';
const ARCHIVE = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e';
const BOBS = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

const DAY = 24 * 60 * 60 * 1000;
const WINDOW = 30 * DAY;
/** The time every test is judged at: a parameter, never the wall clock read inside an assertion. */
const NOW = Date.now();

type Entry = {
  createdAt: number;
  lastAccessAt: number;
  purgedAt?: number;
  purgeReason?: string;
  retentionClass?: string;
  ownerId?: string;
  size?: number;
  holds?: { post: boolean; chat: { heldAt: number; dueAt: number } | null };
};

type Internals = {
  meta: { items: Record<string, Entry> };
  storage: Record<string, unknown>;
  logger: Record<'log' | 'debug' | 'warn' | 'error', (msg: string) => void>;
  persistMetadata: () => Promise<void>;
  purgeExpiredMedia: () => Promise<void>;
  sweepIntervalMs: number;
  uploadLocks: Map<string, Promise<void>>;
};

const entry = (over: Partial<Entry> = {}): Entry => ({
  createdAt: NOW - DAY / 24,
  lastAccessAt: NOW - DAY / 24,
  ...over,
});

function serviceWith(items: Record<string, Entry>, sizes: Record<string, number> = {}) {
  const service = Object.create(MediaService.prototype) as MediaService;
  const deleted: string[] = [];
  const internals = service as unknown as Internals;
  internals.meta = { items };
  internals.storage = {
    delete: (id: string) => {
      deleted.push(id);
      return Promise.resolve();
    },
    get: (id: string) =>
      Promise.resolve(
        id in items && !deleted.includes(id)
          ? {
              async *[Symbol.asyncIterator]() {
                yield Buffer.from('ciphertext');
              },
            }
          : null
      ),
    size: (id: string) => Promise.resolve(deleted.includes(id) ? null : (sizes[id] ?? 10)),
    listObjects: () =>
      Promise.resolve(
        Object.keys(items)
          .filter((id) => !deleted.includes(id))
          .map((id) => ({ id, size: sizes[id] ?? 10, lastModifiedMs: NOW }))
      ),
  };
  internals.logger = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
  internals.uploadLocks = new Map();
  internals.persistMetadata = () => Promise.resolve();
  internals.sweepIntervalMs = 60_000;
  return { service, deleted, sweep: () => internals.purgeExpiredMedia() };
}

/** Runs `fn` with `Date.now()` answering `at`: the sweep reads the clock itself. */
async function at<T>(time: number, fn: () => Promise<T>): Promise<T> {
  const spy = jest.spyOn(Date, 'now').mockReturnValue(time);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

describe('the chat hold route: owner-only, idempotent, charged once', () => {
  it("puts a hold on the owner's pending upload, moves it to chat-reel, and charges its size", async () => {
    const items = { [PENDING]: entry({ ownerId: ALICE, retentionClass: 'reel-pending' }) };
    const { service } = serviceWith(items, { [PENDING]: 20_000_000 });

    const held = await service.holdForChat(PENDING, ALICE, NOW);

    expect(held).toEqual({ status: 'held', dueAt: NOW + WINDOW });
    expect(items[PENDING].retentionClass).toBe('chat-reel');
    expect(items[PENDING].holds).toEqual({
      post: false,
      chat: { heldAt: NOW, dueAt: NOW + WINDOW },
    });
    expect(items[PENDING].size).toBe(20_000_000);
  });

  it('answers a repeat with the SAME hold, and never charges the budget twice', async () => {
    const items = { [PENDING]: entry({ ownerId: ALICE, retentionClass: 'reel-pending' }) };
    // 300 MB: a second charge would cross the 500 MB cap and answer 429.
    const { service } = serviceWith(items, { [PENDING]: 300 * 1024 * 1024 });

    const first = await service.holdForChat(PENDING, ALICE, NOW);
    const again = await service.holdForChat(PENDING, ALICE, NOW + 5_000);

    expect(again).toEqual(first);
    expect(items[PENDING].holds?.chat?.heldAt).toBe(NOW);
  });

  it('writes the hold a chat-reel upload already had, with its UPLOAD due time and no new charge', async () => {
    const uploaded = NOW - 3 * DAY;
    const items = {
      [CHAT_ONLY]: entry({
        ownerId: ALICE,
        retentionClass: 'chat-reel',
        createdAt: uploaded,
        size: 9,
      }),
    };
    const { service } = serviceWith(items);

    expect(await service.holdForChat(CHAT_ONLY, ALICE, NOW)).toEqual({
      status: 'held',
      dueAt: uploaded + WINDOW,
    });
    expect(items[CHAT_ONLY].holds).toEqual({
      post: false,
      chat: { heldAt: uploaded, dueAt: uploaded + WINDOW },
    });
    expect(items[CHAT_ONLY].size).toBe(9);
  });

  it("adds a chat hold to the owner's already-claimed reel, which stays a reel", async () => {
    const items = { [FEED_ONLY]: entry({ ownerId: ALICE, retentionClass: 'reel' }) };
    const { service } = serviceWith(items);

    expect((await service.holdForChat(FEED_ONLY, ALICE, NOW)).status).toBe('held');
    expect(items[FEED_ONLY].retentionClass).toBe('reel');
    expect(items[FEED_ONLY].holds?.post).toBe(true);
  });

  it("refuses somebody else's file, a non-reel class and an unknown or purged id", async () => {
    const items = {
      [BOBS]: entry({ ownerId: BOB, retentionClass: 'reel-pending' }),
      [ARCHIVE]: entry({ ownerId: ALICE, retentionClass: 'archive' }),
      [FILE]: entry({ ownerId: ALICE, purgedAt: NOW - 1, purgeReason: 'reel_expired' }),
    };
    const { service } = serviceWith(items);

    expect(await service.holdForChat(BOBS, ALICE, NOW)).toEqual({ status: 'refused' });
    expect(await service.holdForChat(ARCHIVE, ALICE, NOW)).toEqual({ status: 'refused' });
    expect(await service.holdForChat(FILE, ALICE, NOW)).toEqual({ status: 'gone' });
    expect(await service.holdForChat(PENDING, ALICE, NOW)).toEqual({ status: 'absent' });
    expect(items[BOBS].holds).toBeUndefined();
    expect(items[ARCHIVE].retentionClass).toBe('archive');
    await expect(service.holdForChat('not-a-uuid', ALICE, NOW)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('answers gone for a pending upload already past its 24 h window: the take uploads its own', async () => {
    const items = {
      [PENDING]: entry({
        ownerId: ALICE,
        retentionClass: 'reel-pending',
        createdAt: NOW - 2 * DAY,
      }),
    };
    const { service } = serviceWith(items);

    expect(await service.holdForChat(PENDING, ALICE, NOW)).toEqual({ status: 'gone' });
    expect(items[PENDING].retentionClass).toBe('reel-pending');
  });

  it('refuses a hold past the daily budget with 429, and places nothing', async () => {
    const items = {
      [CHAT_ONLY]: entry({ ownerId: ALICE, retentionClass: 'chat-reel', size: 450 * 1024 * 1024 }),
      [PENDING]: entry({ ownerId: ALICE, retentionClass: 'reel-pending' }),
    };
    const { service } = serviceWith(items, { [PENDING]: 100 * 1024 * 1024 });

    const refusal = await service.holdForChat(PENDING, ALICE, NOW).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(HttpException);
    expect((refusal as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    // The discriminator the client fails the take on (RC-13), never the sentence.
    expect((refusal as HttpException).getResponse()).toMatchObject({ code: CHAT_REEL_OVER_BUDGET });
    expect(items[PENDING].holds).toBeUndefined();
    expect(items[PENDING].retentionClass).toBe('reel-pending');
  });
});

describe('a held reel-pending is not swept at 24 h', () => {
  it('lives past the pending window once a chat holds it, and goes at the chat hold', async () => {
    const items = { [PENDING]: entry({ ownerId: ALICE, retentionClass: 'reel-pending' }) };
    const { service, deleted, sweep } = serviceWith(items);
    await service.holdForChat(PENDING, ALICE, NOW);

    await at(NOW + 2 * DAY, sweep);
    expect(deleted).toEqual([]);

    await at(NOW + WINDOW + DAY, sweep);
    expect(deleted).toEqual([PENDING]);
    expect(items[PENDING].purgeReason).toBe('reel_expired');
  });
});

describe('one file, two holds: published on CanaReels and sent to conversations', () => {
  /** The take of 15.5: the publish step's upload, held by the chats, then claimed by the post. */
  async function publishedAndSent() {
    const items: Record<string, Entry> = {
      [FILE]: entry({ ownerId: ALICE, retentionClass: 'reel-pending' }),
    };
    const harness = serviceWith(items);
    await harness.service.holdForChat(FILE, ALICE, NOW);
    const claim = await harness.service.claimReels([FILE], ALICE);
    expect(claim).toEqual({ claimed: [FILE], refused: [] });
    return { items, ...harness };
  }

  it('the claim accepts chat-reel -> reel and keeps the chat hold', async () => {
    const { items } = await publishedAndSent();
    expect(items[FILE].retentionClass).toBe('reel');
    expect(items[FILE].holds).toEqual({ post: true, chat: { heldAt: NOW, dueAt: NOW + WINDOW } });
  });

  it("survives its post's AUTHOR delete, lives on its chat hold alone, goes with the last hold", async () => {
    const { service, items, deleted, sweep } = await publishedAndSent();

    const results = await service.purgeReels(
      [{ mediaId: FILE, ownerId: ALICE }],
      'author',
      NOW + DAY
    );

    expect(results).toEqual({ [FILE]: 'released' });
    expect(deleted).toEqual([]);
    expect(items[FILE].retentionClass).toBe('chat-reel');
    expect(items[FILE].holds?.post).toBe(false);
    expect((await at(NOW + 2 * DAY, () => service.download(FILE))).status).toBe('ok');

    await at(NOW + WINDOW + DAY, sweep);
    expect(deleted).toEqual([FILE]);
    expect((await service.download(FILE)).status).toBe('purged');
  });

  it("survives its post's RETENTION end the same way", async () => {
    const { service, deleted } = await publishedAndSent();
    expect(
      await service.purgeReels([{ mediaId: FILE, ownerId: ALICE }], 'retention', NOW + DAY)
    ).toEqual({ [FILE]: 'released' });
    expect(deleted).toEqual([]);
  });

  it('survives its 30-day chat hold while the post still holds it, then goes with the post', async () => {
    const { service, items, deleted, sweep } = await publishedAndSent();

    await at(NOW + WINDOW + DAY, sweep);
    expect(deleted).toEqual([]);
    expect((await at(NOW + WINDOW + DAY, () => service.download(FILE))).status).toBe('ok');

    // The post ends after the chat hold lapsed: nothing keeps the file any more.
    const results = await service.purgeReels(
      [{ mediaId: FILE, ownerId: ALICE }],
      'retention',
      NOW + WINDOW + 2 * DAY
    );
    expect(results).toEqual({ [FILE]: 'deleted' });
    expect(deleted).toEqual([FILE]);
    expect(items[FILE].purgeReason).toBe('reel_expired');
    expect((await service.download(FILE)).status).toBe('purged');
  });

  it('goes AT ONCE on a feed moderation purge, chat hold or not, and reads 410 after', async () => {
    const { service, items, deleted } = await publishedAndSent();

    expect(
      await service.purgeReels([{ mediaId: FILE, ownerId: ALICE }], 'moderation', NOW + DAY)
    ).toEqual({ [FILE]: 'deleted' });
    expect(deleted).toEqual([FILE]);
    expect(items[FILE].purgeReason).toBe('reel_moderated');
    expect((await service.download(FILE)).status).toBe('purged');
  });

  it("goes AT ONCE on a salon moderator's purge, and reads 410 after", async () => {
    const { service, items, deleted } = await publishedAndSent();

    expect(await service.purgeChatReels([{ mediaId: FILE, ownerId: ALICE }], NOW)).toEqual({
      [FILE]: 'deleted',
    });
    expect(deleted).toEqual([FILE]);
    expect(items[FILE].purgeReason).toBe('reel_moderated');
    expect((await service.download(FILE)).status).toBe('purged');
  });

  it("the sender's delete releases the chat hold only; the post keeps the file; a repeat succeeds", async () => {
    const { service, items, deleted } = await publishedAndSent();

    expect(await service.removeChatReel(FILE, ALICE)).toBe('released');
    expect(deleted).toEqual([]);
    expect(items[FILE].retentionClass).toBe('reel');
    expect(items[FILE].holds).toEqual({ post: true, chat: null });
    expect(await service.removeChatReel(FILE, ALICE)).toBe('absent');

    // And the post's own end now deletes it: no chat hold is left to keep it.
    expect(await service.purgeReels([{ mediaId: FILE, ownerId: ALICE }], 'author', NOW)).toEqual({
      [FILE]: 'deleted',
    });
  });

  it('counts the shared file on its own stats line, inside the reel line', async () => {
    const { service } = await publishedAndSent();
    const stats = await service.getStorageStats();
    expect(stats.reelCount).toBe(1);
    expect(stats.sharedReelCount).toBe(1);
    expect(stats.sharedReelBytes).toBe(10);
  });

  it("a release asked through the retention class (the post's fallback) ends the post hold only", async () => {
    const { service, items } = await publishedAndSent();
    expect(await service.setRetentionClass([FILE], 'ephemeral')).toBe(1);
    expect(items[FILE].retentionClass).toBe('chat-reel');
    expect(items[FILE].holds).toEqual({ post: false, chat: { heldAt: NOW, dueAt: NOW + WINDOW } });
  });
});

describe("the sender's delete of a chats-only file", () => {
  it('deletes it at once (the only hold), tombstoned 410', async () => {
    const items = { [CHAT_ONLY]: entry({ ownerId: ALICE, retentionClass: 'chat-reel' }) };
    const { service, deleted } = serviceWith(items);
    await service.holdForChat(CHAT_ONLY, ALICE, NOW);

    expect(await service.removeChatReel(CHAT_ONLY, ALICE)).toBe('deleted');
    expect(deleted).toEqual([CHAT_ONLY]);
    expect((await service.download(CHAT_ONLY)).status).toBe('purged');
  });

  it("refuses a feed reel nobody sent, and somebody else's held file", async () => {
    const items = {
      [FEED_ONLY]: entry({ ownerId: ALICE, retentionClass: 'reel' }),
      [BOBS]: entry({ ownerId: BOB, retentionClass: 'chat-reel' }),
    };
    const { service, deleted } = serviceWith(items);
    expect(await service.removeChatReel(FEED_ONLY, ALICE)).toBe('refused');
    expect(await service.removeChatReel(BOBS, ALICE)).toBe('refused');
    expect(deleted).toEqual([]);
  });
});

describe("a salon moderator's purge: the row's author must be the uploader, and a chat must hold it", () => {
  it("refuses a row that declared ANOTHER member's file: owner mismatch", async () => {
    const items = { [BOBS]: entry({ ownerId: BOB, retentionClass: 'chat-reel' }) };
    const { service, deleted } = serviceWith(items);
    // Alice's salon row declared Bob's id; social-service names the row's author, Alice.
    expect(await service.purgeChatReels([{ mediaId: BOBS, ownerId: ALICE }], NOW)).toEqual({
      [BOBS]: 'refused',
    });
    expect(deleted).toEqual([]);
    expect(items[BOBS].purgedAt).toBeUndefined();
  });

  it("refuses the author's own file that no conversation holds: a feed reel, a feed photo", async () => {
    const items = {
      [FEED_ONLY]: entry({ ownerId: ALICE, retentionClass: 'reel' }),
      [ARCHIVE]: entry({ ownerId: ALICE, retentionClass: 'archive' }),
    };
    const { service, deleted } = serviceWith(items);
    expect(
      await service.purgeChatReels(
        [
          { mediaId: FEED_ONLY, ownerId: ALICE },
          { mediaId: ARCHIVE, ownerId: ALICE },
        ],
        NOW
      )
    ).toEqual({ [FEED_ONLY]: 'refused', [ARCHIVE]: 'refused' });
    expect(deleted).toEqual([]);
  });

  it('answers absent for what is already gone, so a retry succeeds', async () => {
    const { service } = serviceWith({
      [CHAT_ONLY]: entry({ ownerId: ALICE, purgedAt: NOW, purgeReason: 'reel_moderated' }),
    });
    expect(await service.purgeChatReels([{ mediaId: CHAT_ONLY, ownerId: ALICE }], NOW)).toEqual({
      [CHAT_ONLY]: 'absent',
    });
  });
});

/** Holds the store's delete open until `open()`, so a test can act DURING the await. */
function gateDeletes(service: MediaService) {
  const storage = (service as unknown as Internals).storage;
  const inner = storage.delete as (id: string) => Promise<void>;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let reached!: () => void;
  const started = new Promise<void>((resolve) => (reached = resolve));
  storage.delete = async (id: string) => {
    reached();
    await gate;
    return inner(id);
  };
  return { open, started };
}

describe('a delete in flight is never overwritten by a hold or a claim placed during its await', () => {
  it("the author's post delete vs a take's chat hold: the hold is refused, never answered held", async () => {
    const items = { [FEED_ONLY]: entry({ ownerId: ALICE, retentionClass: 'reel' }) };
    const { service, deleted } = serviceWith(items);
    const gate = gateDeletes(service);

    const purging = service.purgeReels([{ mediaId: FEED_ONLY, ownerId: ALICE }], 'author', NOW);
    await gate.started;
    const held = await service.holdForChat(FEED_ONLY, ALICE, NOW);
    gate.open();

    expect(held).toEqual({ status: 'gone' });
    expect(await purging).toEqual({ [FEED_ONLY]: 'deleted' });
    expect(deleted).toEqual([FEED_ONLY]);
  });

  it("the sender's delete vs the post's claim: the claim is refused, no post cites a deleted file", async () => {
    const items = { [CHAT_ONLY]: entry({ ownerId: ALICE, retentionClass: 'chat-reel' }) };
    const { service, deleted } = serviceWith(items);
    const gate = gateDeletes(service);

    const removing = service.removeChatReel(CHAT_ONLY, ALICE);
    await gate.started;
    const claim = await service.claimReels([CHAT_ONLY], ALICE);
    gate.open();

    expect(claim).toEqual({ claimed: [], refused: [CHAT_ONLY] });
    expect(await removing).toBe('deleted');
    expect(deleted).toEqual([CHAT_ONLY]);
    expect(items[CHAT_ONLY].purgeReason).toBe('reel_deleted');
  });

  it('a failed delete puts the entry back, so the retry finds the file instead of `absent`', async () => {
    const items = { [CHAT_ONLY]: entry({ ownerId: ALICE, retentionClass: 'chat-reel' }) };
    const { service } = serviceWith(items);
    (service as unknown as Internals).storage.delete = () =>
      Promise.reject(new Error('store down'));

    expect(await service.purgeChatReels([{ mediaId: CHAT_ONLY, ownerId: ALICE }], NOW)).toEqual({
      [CHAT_ONLY]: 'failed',
    });
    expect(items[CHAT_ONLY].purgedAt).toBeUndefined();
    expect(items[CHAT_ONLY].retentionClass).toBe('chat-reel');
  });
});

describe('an older social-service naming NO reason (legacy shim)', () => {
  it('deletes a reel no chat holds, exactly as before', async () => {
    const items = { [FEED_ONLY]: entry({ ownerId: ALICE, retentionClass: 'reel' }) };
    const { service, deleted } = serviceWith(items);
    expect(
      await service.purgeReels([{ mediaId: FEED_ONLY, ownerId: ALICE }], undefined, NOW)
    ).toEqual({ [FEED_ONLY]: 'deleted' });
    expect(deleted).toEqual([FEED_ONLY]);
    expect(items[FEED_ONLY].purgeReason).toBe('manual_delete');
  });

  it('a file a LIVE chat hold keeps: the post hold is released, the file kept, the answer `refused`', async () => {
    const items = {
      [FILE]: entry({
        ownerId: ALICE,
        retentionClass: 'reel',
        holds: { post: true, chat: { heldAt: NOW, dueAt: NOW + WINDOW } },
      }),
    };
    const { service, deleted, sweep } = serviceWith(items);
    expect(await service.purgeReels([{ mediaId: FILE, ownerId: ALICE }], undefined, NOW)).toEqual({
      [FILE]: 'refused',
    });
    expect(deleted).toEqual([]);
    // The old caller drops its post row now: nothing may be left that keeps the file for ever.
    expect(items[FILE].holds).toEqual({ post: false, chat: { heldAt: NOW, dueAt: NOW + WINDOW } });
    expect(items[FILE].retentionClass).toBe('chat-reel');
    await at(NOW + WINDOW + DAY, sweep);
    expect(deleted).toEqual([FILE]);
  });

  it('a file whose chat hold LAPSED is deleted, exactly as before', async () => {
    const items = {
      [FILE]: entry({
        ownerId: ALICE,
        retentionClass: 'reel',
        holds: { post: true, chat: { heldAt: NOW - 40 * DAY, dueAt: NOW - 10 * DAY } },
      }),
    };
    const { service, deleted } = serviceWith(items);
    expect(await service.purgeReels([{ mediaId: FILE, ownerId: ALICE }], undefined, NOW)).toEqual({
      [FILE]: 'deleted',
    });
    expect(deleted).toEqual([FILE]);
  });
});

describe('a lapsed chat hold under a live post keeps nothing', () => {
  const lapsed = () => ({
    [FILE]: entry({
      ownerId: ALICE,
      retentionClass: 'reel',
      size: 10,
      holds: { post: true, chat: { heldAt: NOW - 40 * DAY, dueAt: NOW - 10 * DAY } },
    }),
  });

  it('a new take may hold the published reel again, with a fresh due time', async () => {
    const items = lapsed();
    const { service } = serviceWith(items);
    expect(await service.holdForChat(FILE, ALICE, NOW)).toEqual({
      status: 'held',
      dueAt: NOW + WINDOW,
    });
    expect(items[FILE].holds).toEqual({ post: true, chat: { heldAt: NOW, dueAt: NOW + WINDOW } });
  });

  it('is not counted as shared in the stats', async () => {
    const { service } = serviceWith(lapsed());
    const stats = await service.getStorageStats();
    expect(stats.reelCount).toBe(1);
    expect(stats.sharedReelCount).toBe(0);
  });

  it('does not let a salon moderator purge the published reel through it', async () => {
    const items = lapsed();
    const { service, deleted } = serviceWith(items);
    expect(await service.purgeChatReels([{ mediaId: FILE, ownerId: ALICE }], NOW)).toEqual({
      [FILE]: 'refused',
    });
    expect(deleted).toEqual([]);
  });
});
