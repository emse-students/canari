import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withoutAnyComments } from '../styles/markupSources';
import { ApiRefusalError, describeApiRefusal, refusalCode, refusalStatus } from './apiRefusal';
import { ChannelApiError } from '$lib/services/ChannelService';
import { CallInitiateError } from './callFailure';

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

describe('refusalStatus and refusalCode', () => {
  /**
   * THE READERS ARE ASSERTED THROUGH THE SUBCLASSES, NOT THROUGH THE BASE ALONE.
   *
   * The base class buys exactly one thing: a screen catching a refusal can ask for the number
   * without naming the service that threw it. An assertion that only ever constructed
   * `ApiRefusalError` would pass while a subclass quietly stopped handing `super` its status,
   * which is the failure these are written against.
   */
  it('reads the status and the code a channel refusal carries', () => {
    expect(refusalStatus(new ChannelApiError(429, 'RATE_LIMITED', 'slow down'))).toBe(429);
    expect(refusalCode(new ChannelApiError(429, 'RATE_LIMITED', 'slow down'))).toBe('RATE_LIMITED');
  });

  it('reads the status a call refusal carries, and no code', () => {
    // `CallInitiateError` passes `null`: the initiate route answers a status and a body, so a code
    // slot would be a discriminator nothing ever sets.
    expect(refusalStatus(new CallInitiateError(404, 'calls/initiate failed (404)'))).toBe(404);
    expect(refusalCode(new CallInitiateError(404, 'calls/initiate failed (404)'))).toBeNull();
  });

  it('keeps each subclass distinguishable by name', () => {
    expect(new ChannelApiError(500, null, 'x').name).toBe('ChannelApiError');
    expect(new CallInitiateError(500, 'x').name).toBe('CallInitiateError');
    expect(new ChannelApiError(500, null, 'x')).toBeInstanceOf(ApiRefusalError);
    expect(new CallInitiateError(500, 'x')).toBeInstanceOf(ApiRefusalError);
  });

  it.each([
    ['a transport failure', new TypeError('Failed to fetch')],
    ['an ordinary Error', new Error('boom')],
    ['a thrown string', 'boom'],
    ['null', null],
  ])('answers null for %s, which answered nothing', (_label, thrown) => {
    // NOBODY ANSWERED is not a status, and it is not a 0 either. The contract of
    // `describeApiRefusal` rests on this: it says nothing about a status it was not given.
    expect(refusalStatus(thrown)).toBeNull();
    expect(refusalCode(thrown)).toBeNull();
  });

  it('describes a refusal read through the accessor exactly as one read by hand', () => {
    // The refactor's only obligation: ten call sites dropped their own `instanceof` ternary for
    // these two readers, and not one rendered sentence may move.
    const error = new ChannelApiError(403, null, "the server's own English");

    expect(describeApiRefusal(refusalStatus(error), ACTION)).toBe(describeApiRefusal(403, ACTION));
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
