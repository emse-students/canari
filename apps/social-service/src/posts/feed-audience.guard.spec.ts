import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { FeedAudienceGuard } from './feed-audience.guard';
import { FEED_AUDIENCE_WHERE, IS_FEED_AUDIENCE_SQL } from './feed-audience';

/**
 * THE GATE THAT WAS MISSING, AND THE THREE SHAPES THE BACKLOG ASKED FOR: ICM, admin, neither.
 *
 * The fourth case is the one that made this a defect rather than an omission - a caller with no
 * identity at all, which reached the endpoint and got 200 with post bodies.
 */

/** A context carrying exactly the headers nginx would set, and nothing else. */
function contextWith(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

/**
 * A guard wired to a fake table. `rows` is what the query returns, and `calls` records what it was
 * asked - the SQL text matters here as much as the verdict, because the whole defect was a rule
 * stated in more than one place.
 */
function guardOver(inAudience: boolean) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const repo = {
    manager: {
      query: (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return Promise.resolve([{ inAudience }]);
      },
    },
  };
  return { guard: new FeedAudienceGuard(repo as never), calls };
}

describe('FeedAudienceGuard', () => {
  it('lets a member of the audience through', async () => {
    const { guard } = guardOver(true);
    await expect(guard.canActivate(contextWith({ 'x-user-id': 'icm-student' }))).resolves.toBe(
      true
    );
  });

  it('refuses somebody the predicate does not match', async () => {
    const { guard } = guardOver(false);
    await expect(
      guard.canActivate(contextWith({ 'x-user-id': 'other-formation' }))
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses a caller with no identity, which is how the feed was public', async () => {
    const { guard, calls } = guardOver(true);
    await expect(guard.canActivate(contextWith({}))).rejects.toThrow(ForbiddenException);
    // And it does not even ask: an absent id must never be handed to the predicate, where a
    // mistake in the SQL could turn it into a match.
    expect(calls).toEqual([]);
  });

  it('asks about the caller and nobody else', async () => {
    const { guard, calls } = guardOver(true);
    await guard.canActivate(contextWith({ 'x-user-id': 'me' }));
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual(['me']);
    expect(calls[0].sql).toBe(IS_FEED_AUDIENCE_SQL);
  });

  it('does NOT consult x-global-admin, because the predicate already covers admins', async () => {
    // Stating half the rule again in a header check is the shape this whole defect had: one
    // decision in two places. An admin is admitted by the SQL or not at all.
    const { guard } = guardOver(false);
    await expect(
      guard.canActivate(contextWith({ 'x-user-id': 'someone', 'x-global-admin': 'true' }))
    ).rejects.toThrow(ForbiddenException);
  });

  it('treats a row that answers nothing as a refusal', async () => {
    const repo = { manager: { query: () => Promise.resolve([]) } };
    const guard = new FeedAudienceGuard(repo as never);
    await expect(guard.canActivate(contextWith({ 'x-user-id': 'me' }))).rejects.toThrow(
      ForbiddenException
    );
  });

  it('refuses a truthy-but-not-true answer rather than coercing it', async () => {
    // `EXISTS` gives a real boolean, but a driver change that started returning 't' or 1 must not
    // silently widen the gate. The check is `=== true` and this is what holds it there.
    const repo = { manager: { query: () => Promise.resolve([{ inAudience: 'f' }]) } };
    const guard = new FeedAudienceGuard(repo as never);
    await expect(guard.canActivate(contextWith({ 'x-user-id': 'me' }))).rejects.toThrow(
      ForbiddenException
    );
  });
});

describe('IS_FEED_AUDIENCE_SQL', () => {
  it('parenthesises the audience fragment, because AND binds tighter than OR', () => {
    // Measured on the local copy of production with an id belonging to nobody: the unparenthesised
    // form matched 4 rows - the school's four administrators - and the parenthesised form matched
    // 0. Without these brackets the gate admits any anonymous caller for as long as one admin
    // account exists, which is a hole in the shape of a fix.
    expect(IS_FEED_AUDIENCE_SQL).toContain(`(${FEED_AUDIENCE_WHERE})`);
  });

  it('filters on the id it is given', () => {
    expect(IS_FEED_AUDIENCE_SQL).toContain('id = $1');
  });

  it('states the rule once, by building on the shared fragment', () => {
    // If somebody re-types the predicate here, this fails: the constant would no longer be a
    // substring of a hand-written copy that drifted.
    expect(IS_FEED_AUDIENCE_SQL).toContain(FEED_AUDIENCE_WHERE);
  });
});
