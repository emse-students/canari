import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SocialApiError } from './api';

/**
 * THE SERVER'S ENGLISH MUST NOT REACH A FRENCH PAGE, AND ONE CODE PATH IS WHY IT DID.
 *
 * `request()` threw `new Error(serverMessage)`, and the partnership screen showed that message
 * because it had nothing else - so "No codes left for this partnership" appeared mid-page to a
 * student (user, 2026-09-10). The cure is the standing rule about never branching on an error
 * MESSAGE, applied one step earlier: the server classifies at the THROW with a code, and the
 * screen translates the code.
 *
 * These assertions hold the two halves that make that true.
 */

const SHOP_LIST = join(process.cwd(), 'src/lib/components/shop/PartnershipCardList.svelte');

describe('SocialApiError', () => {
  it('carries the code beside the sentence', () => {
    const e = new SocialApiError('No codes left for this partnership', 'PARTNERSHIP_NO_CODES_LEFT');
    expect(e.code).toBe('PARTNERSHIP_NO_CODES_LEFT');
    expect(e).toBeInstanceOf(Error);
  });

  // Two hundred call sites already catch `Error` from this module. Widening the thrown type must
  // not narrow what they catch, or a screen that handled a refusal stops handling it.
  it('is still an Error, so every existing catch still catches it', () => {
    const e: unknown = new SocialApiError('boom', null);
    expect(e instanceof Error).toBe(true);
  });

  it('accepts a null code, because most refusals still carry none', () => {
    expect(new SocialApiError('boom', null).code).toBeNull();
  });
});

/**
 * The file with its prose removed. The first run of the assertion below failed on the DOCBLOCK
 * that explains the defect - it names `e.message` in order to say why nothing may render it -
 * which would have made the rule impossible to document beside the code it governs.
 */
function codeOnly(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the partnership claim screen', () => {
  const source = codeOnly(readFileSync(SHOP_LIST, 'utf8'));

  /**
   * THE ASSERTION THAT ACTUALLY CLOSES THE DEFECT. Translating the four known codes fixes four
   * sentences; not printing `.message` is what stops the fifth. A future refusal with a code
   * nobody has translated yet must read as the generic line, never as whatever English the
   * server happened to send.
   */
  it('never renders a server sentence', () => {
    expect(source).not.toMatch(/\.message\b/);
  });

  it('translates every code the claim path can refuse with', () => {
    // The four the service throws, from `partnerships.service.ts`. If one is added there without
    // a translation here it shows the generic line, which is safe - but these four were the
    // report, so they are named.
    for (const code of [
      'PARTNERSHIP_NO_CODES_LEFT',
      'PARTNERSHIP_MEMBERS_ONLY',
      'PARTNERSHIP_NOT_FOUND',
      'ASSOCIATION_NOT_FOUND',
    ]) {
      expect(source).toContain(code);
    }
  });

  it('discriminates on the code and not on the prose', () => {
    expect(source).toContain('SocialApiError');
    expect(source).not.toMatch(/includes\(['"]No codes/);
  });
});
