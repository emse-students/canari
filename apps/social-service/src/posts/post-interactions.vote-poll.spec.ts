import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { PostInteractionsService } from './post-interactions.service';
import { Post } from './entities/post.entity';
import { PostNotificationsService } from './post-notifications.service';
import { PushService } from '../push/push.service';
import { PostMediaRetentionService } from './post-media-retention.service';

/**
 * WHAT A POLL ALLOWS IS DECIDED HERE, AND UNTIL 2026-09-23 IT WAS DECIDED NOWHERE.
 *
 * `votePoll` recorded whatever `optionIds` it was handed. `multipleChoice: false` was a rendering
 * convention - radio inputs send one id, so one id is what arrived - and an `endsAt` in the past
 * only ever hid the buttons on the card. None of that survives a request written by hand, which is
 * the whole point of a cap: an author asking for "two of these five" is stating a rule, and a rule
 * only the client applies is a rule anyone can decline to apply.
 *
 * The client halves are pinned in `pollVote.test.ts` (what a tap produces) and `pollDraft.test.ts`
 * (what may be composed). This file pins the only one that is not advisory.
 */
describe('PostInteractionsService.votePoll enforces the poll', () => {
  function makeService(poll: Record<string, unknown>) {
    const post = { id: 'post-1', polls: [poll] };
    const saved: unknown[] = [];
    const manager = {
      createQueryBuilder: () => ({
        where: () => ({ setLock: () => ({ getOne: () => Promise.resolve(post) }) }),
      }),
      save: (entity: unknown) => {
        saved.push(entity);
        return Promise.resolve(entity);
      },
    };
    const postRepo = {
      manager: { transaction: (fn: (m: unknown) => Promise<void>) => fn(manager) },
    };
    const service = new PostInteractionsService(
      postRepo as unknown as Repository<Post>,
      {} as PostNotificationsService,
      {} as PushService,
      {} as PostMediaRetentionService
    );
    return { service, post, saved };
  }

  const options = () => [
    { id: 'a', label: 'A', votes: [] },
    { id: 'b', label: 'B', votes: [] },
    { id: 'c', label: 'C', votes: [] },
  ];

  it('refuses more than one option on a single-choice poll', async () => {
    const { service } = makeService({
      id: 'p1',
      multipleChoice: false,
      options: options(),
      votesByUser: {},
    });

    await expect(
      service.votePoll('post-1', 'p1', { userId: 'u1', optionIds: ['a', 'b'] })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a selection past the cap the author set', async () => {
    const { service } = makeService({
      id: 'p1',
      multipleChoice: true,
      maxSelections: 2,
      options: options(),
      votesByUser: {},
    });

    await expect(
      service.votePoll('post-1', 'p1', { userId: 'u1', optionIds: ['a', 'b', 'c'] })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a selection at the cap', async () => {
    const { service, post } = makeService({
      id: 'p1',
      multipleChoice: true,
      maxSelections: 2,
      options: options(),
      votesByUser: {},
    });

    await service.votePoll('post-1', 'p1', { userId: 'u1', optionIds: ['a', 'b'] });

    expect(post.polls[0].votesByUser.u1).toEqual(['a', 'b']);
  });

  it('refuses every vote once the poll has closed', async () => {
    const { service } = makeService({
      id: 'p1',
      multipleChoice: true,
      endsAt: new Date(Date.now() - 60_000).toISOString(),
      options: options(),
      votesByUser: {},
    });

    await expect(
      service.votePoll('post-1', 'p1', { userId: 'u1', optionIds: ['a'] })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('drops an option id this poll does not have, rather than storing it as a selection', async () => {
    // It cast no vote either way - but it WAS written into `votesByUser`, and came back to every
    // reader as part of somebody's answer. The likeliest source is a stale option list, which is
    // why the rest of the selection still stands.
    const { service, post } = makeService({
      id: 'p1',
      multipleChoice: true,
      options: options(),
      votesByUser: {},
    });

    await service.votePoll('post-1', 'p1', { userId: 'u1', optionIds: ['a', 'ghost'] });

    expect(post.polls[0].votesByUser.u1).toEqual(['a']);
    expect(post.polls[0].options.map((o: { id: string; votes: string[] }) => o.votes)).toEqual([
      ['u1'],
      [],
      [],
    ]);
  });

  it('counts a repeated option once, so a duplicate cannot spend the cap', async () => {
    const { service, post } = makeService({
      id: 'p1',
      multipleChoice: true,
      maxSelections: 2,
      options: options(),
      votesByUser: {},
    });

    await service.votePoll('post-1', 'p1', { userId: 'u1', optionIds: ['a', 'a', 'b'] });

    expect(post.polls[0].votesByUser.u1).toEqual(['a', 'b']);
  });

  it('still lets a voter withdraw entirely', async () => {
    const { service, post } = makeService({
      id: 'p1',
      multipleChoice: false,
      options: [
        { id: 'a', label: 'A', votes: ['u1'] },
        { id: 'b', label: 'B', votes: [] },
        { id: 'c', label: 'C', votes: [] },
      ],
      votesByUser: { u1: ['a'] },
    });

    await service.votePoll('post-1', 'p1', { userId: 'u1', optionIds: [] });

    expect(post.polls[0].votesByUser.u1).toEqual([]);
    expect(post.polls[0].options[0].votes).toEqual([]);
  });

  it('refuses a user id that would shadow a property of the map it is written into', async () => {
    // `Object.create(null)` stops the shadowing; it does not stop the map CARRYING the key, which
    // then travels to every reader of the poll and to JSON. The channel poll has refused this
    // since CodeQL #2477/#2476 and the post poll had only the null prototype.
    const { service } = makeService({
      id: 'p1',
      multipleChoice: true,
      options: options(),
      votesByUser: {},
    });

    await expect(
      service.votePoll('post-1', 'p1', { userId: '__proto__', optionIds: ['a'] })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
