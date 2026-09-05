/**
 * WHAT THE VENUE CHANNEL'S HISTORY PERMANENTLY CONTAINS, AND THE ONLY 404s IT MAY PRODUCE.
 *
 * ## Why this is a file of its own
 *
 * It reads `names.mjs`, which is OUT OF TREE - and `make test-harness` must run from the repository
 * alone. Putting these constants in `watch.mjs` made `classify-selftest.mjs` and
 * `logcatclassify-selftest.mjs` depend on a file CI does not have, and `gate-selftest.mjs` refused
 * the build within the minute: "needs names.mjs ... not in git, so CI has none of it". No self-test
 * imports this module, and none should - it is for RUNNERS, which have an estate to talk to.
 *
 *   import { ignoringStrandedMentions } from '../stranded.mjs';
 */
import { ignoringExpectedRefusal } from './watch.mjs';
import { createHash } from 'node:crypto';
import { STRANDED_ABSENT_MENTION_IDS } from './names.mjs';

/**
 * THE ONE FABRICATED USER ID THE CAMPAIGN MENTIONS, AND WHY IT IS A CONSTANT.
 *
 * MENTION-5 types a well-formed `@[64-hex]` that belongs to nobody - that is the row. What was not
 * intended is that the message SURVIVES it: it stays in the venue channel for ever, and every later
 * check that opens that conversation re-renders its chip and asks `/api/users/<id>`, which can only
 * 404. Behind `randomBytes(32)` that meant EVERY RUN OF MENTION-5 STRANDED A NEW ONE, and a check
 * that permanently degrades the estate it measures is not reproducible.
 *
 * Derived from a phrase rather than written out, so a reader can see at a glance that it names
 * nobody and so it is the same value on every machine and in every run.
 */
export const ABSENT_MENTION_ID = createHash('sha256')
  .update('canari-cross-client-campaign-absent-user')
  .digest('hex');

/**
 * The 404s the venue channel is ALLOWED to produce, as pairs {@link ignoringExpectedRefusal} takes.
 *
 * AN ALLOWLIST, NOT THE `[0-9a-f]{64}` SHAPE. Forgiving the shape would forgive a 404 on a real
 * member's profile, which is a defect this campaign exists to catch; this names exactly what is
 * known to be stranded. THE LIST CANNOT GROW - the id above is fixed, so a MENTION-5 re-run reuses
 * the same message rather than adding to it. The residue of the randomised era is out of tree in
 * `names.mjs`, because 64 hex digits read like an account whether or not they are one and this
 * repository is public.
 *
 * A PAIR, exactly like COMM's provoked 403s: the path alone would swallow a 500 from the user
 * endpoint, the status alone one from anywhere else on the page.
 */
export const ABSENT_MENTION_404 = [ABSENT_MENTION_ID, ...STRANDED_ABSENT_MENTION_IDS].map((id) => ({
  path: new RegExp(`^/api/users/${id}$`),
  status: [404],
}));

/**
 * The same report with those - and only those - forgiven.
 *
 * IT LIVES HERE RATHER THAN IN THE CHECK THAT CAUSED IT because the cost is not paid there. Any row
 * that so much as OPENS the venue channel renders those chips: MENTION-2, MENTION-3 and MENTION-6
 * recorded PASS-DIRTY on them, and FWD-1 did too on its first green run - a forward that arrived in
 * 108 ms with one copy and no loss, reported dirty for a user profile it never asked about.
 *
 * THE MESSAGES ARE DELIBERATELY LEFT IN PLACE. A channel whose history contains a mention of an
 * account that does not exist is a REAL situation - a deleted member - and since 2026-09-05 the
 * client answers it correctly, rendering the unknown-user label and asking once per session. So
 * every row that opens that conversation now exercises that path for free. Deleting the fixture
 * would remove the coverage and change nothing about the forgiveness, which names three ids.
 */
export function ignoringStrandedMentions(rep) {
  return ignoringExpectedRefusal(rep, ABSENT_MENTION_404);
}
