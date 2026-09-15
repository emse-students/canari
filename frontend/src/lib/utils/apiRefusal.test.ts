import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withoutAnyComments } from '../styles/markupSources';
import { describeApiRefusal } from './apiRefusal';

/**
 * A REFUSAL IS DESCRIBED FROM ITS STATUS, NEVER FROM THE SERVER'S SENTENCE.
 *
 * The server's exception messages are dev-facing and English, and correctly so. This helper exists
 * so a client has something better to render than one of them. The assertions below are therefore
 * about two things only: that each status it claims to know becomes a DIFFERENT localized line,
 * and that everything else returns `null` so the caller keeps its own generic wording.
 */
const ACTION = 'ACTION';

describe('describeApiRefusal', () => {
  it.each([
    [401, 'session'],
    [403, 'forbidden'],
    [404, 'gone'],
    [409, 'conflict'],
    [429, 'rate limited'],
  ])('answers %i with a localized sentence naming the action', (status) => {
    const out = describeApiRefusal(status, ACTION);

    expect(out).not.toBeNull();
    expect(out).toContain(ACTION);
  });

  it('gives each status it knows a DISTINCT sentence', () => {
    // The whole point of the change: before it, a 403 and a 500 read identically, so the reader
    // could not tell a refusal they could act on from a fault they could not. Four identical
    // strings would pass every assertion above and still be that defect.
    const sentences = [401, 403, 404, 409, 429].map((s) => describeApiRefusal(s, ACTION));

    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it.each([[400], [422], [500], [502], [503]])(
    'returns null for %i, leaving the caller its own generic line',
    (status) => {
      // 400 deliberately: a validation refusal carries a CODE, which is more precise than any
      // status, so answering it generically here would OVERRIDE the better sentence. 5xx
      // deliberately: a 502 from the edge is a reachability failure the caller may classify
      // better than this can.
      expect(describeApiRefusal(status, ACTION)).toBeNull();
    }
  );

  it('returns null for an error that carries no status at all', () => {
    // An absent status is a question nobody answered, never a default - a plain Error from a
    // transport failure must not be described as though the server had refused something.
    expect(describeApiRefusal(null, ACTION)).toBeNull();
    expect(describeApiRefusal(undefined, ACTION)).toBeNull();
  });
});

describe('the helper itself', () => {
  // THE FILE WITH ITS PROSE REMOVED, for the reason `socialApiError.test.ts` already paid for:
  // the docblock next door names `detail` and `.message` in order to say why neither may
  // appear, so asserting against the raw text would make the rule impossible to document
  // beside the code it governs. The stripper is the SHARED one - a private copy is what this
  // repository has already answered three high CodeQL alerts for.
  const source = withoutAnyComments(
    readFileSync(join(process.cwd(), 'src/lib/utils/apiRefusal.ts'), 'utf8')
  );

  /**
   * THE ASSERTION THAT KEEPS IT HONEST. The proven mapper this generalises interpolates the
   * backend's own words into its 403 and its generic arm. A helper whose purpose is to keep that
   * prose away from a reader must not grow a slot to put it back in - and a `detail` parameter is
   * exactly how it would.
   */
  it('takes no slot for prose that crossed the network', () => {
    expect(source).not.toMatch(/\bdetail\b/);
    expect(source).not.toMatch(/\.message\b/);
  });
});
