import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE FEED AUDIENCE RULE IS STATED ONCE PER SIDE, AND THIS IS THE CLIENT'S HALF.
 *
 * "ICM students, plus global admins" was written out twice in the routes - the same eleven lines,
 * the same two `catch` branches, the same redirect - and announcing posts made the server need the
 * rule as well. Three copies of one decision in two languages is the point at which the decision
 * stops being changeable, so the two client copies became `redirectIfNotFeedAudience` and this
 * fails if either comes back.
 *
 * A SOURCE GUARD AND NOT A BEHAVIOUR TEST, deliberately. What went wrong was never that one copy
 * behaved differently on the day it was written - it is that a later edit reaches one copy. Only
 * reading the source can see that.
 *
 * The routes dir comes from `process.cwd()` and not from `import.meta.url`: under Vite this
 * module's `import.meta.url` is not a `file:` URL, so `fileURLToPath` throws and `.pathname`
 * yields a plausible-but-wrong `/F:/src/routes`. `sessionExpiredRelease.test.ts` records the same
 * trap.
 */
const ROUTES = join(process.cwd(), 'src/routes');

const GATED = ['posts/+page.ts', 'posts/[postId]/+page.ts'];

describe('the feed audience gate', () => {
  it.each(GATED)('%s asks the helper rather than restating the rule', (route) => {
    const source = readFileSync(join(ROUTES, route), 'utf8');
    expect(source).toContain('redirectIfNotFeedAudience');
    // The rule itself - the formation string and the redirect target - belongs to the helper.
    expect(source).not.toContain("'ICM'");
    expect(source).not.toContain("goto('/chat'");
  });

  it('is the only place in the routes that decides who may see the feed', () => {
    // `formation === 'ICM'` appears legitimately elsewhere (a profile form, a filter); what must
    // not reappear is the PAIR of that test and the redirect it used to guard.
    const offenders = GATED.filter((route) => {
      const source = readFileSync(join(ROUTES, route), 'utf8');
      return /formation\s*!==\s*'ICM'/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
