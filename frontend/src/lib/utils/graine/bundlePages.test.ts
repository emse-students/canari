import { canari } from '$lib/proto/canari';
import { decodeAppMessage, encodeAppMessage, mkGraineBundle } from '$lib/proto/codec';
import { GRAINE_BUNDLE_PAGE_MAX_BYTES } from '$lib/crypto/graineConstants';
import { pageGraineBundle, type GraineAnswer } from './bundlePages';

/**
 * ONE ANSWER, BOUNDED IN BYTES (dm-vs-community-encryption, "the history bundle"): the cap was a
 * seed count, and a v2 seed is ~330 bytes, so 8 000 of them were ~2.6 MB in one MLS message.
 */

/** A v2 seed shaped like production's: ids of the measured lengths, every v2 field set. */
function seed(channel: string, n: number): canari.GraineMsg.$Properties {
  return {
    channelId: `${channel}-0000-0000-0000-000000000000`.slice(0, 36),
    sessionId: `session-${String(n).padStart(16, '0')}`,
    seed: new Uint8Array(32).fill(n % 251),
    firstIndex: 0,
    createdAt: 1_700_000_000_000 + n,
    version: 2,
    minterUserId: 'u'.repeat(64),
    minterDeviceId: 'd'.repeat(83),
    signingPublicKey: new Uint8Array(32).fill(1),
    endorsement: new Uint8Array(64).fill(2),
  };
}

function answer(seeds: canari.GraineMsg.$Properties[], extra: Partial<GraineAnswer> = {}) {
  return {
    workspaceId: '11111111-2222-3333-4444-555555555555',
    requestId: 'request-0123456789abcdef',
    seeds,
    missing: [],
    truncated: false,
    holdsNothing: false,
    ...extra,
  } satisfies GraineAnswer;
}

const encodedSize = (page: canari.GraineBundleMsg.$Properties) =>
  encodeAppMessage(mkGraineBundle(page)).length;

describe('pageGraineBundle', () => {
  it('keeps an answer that fits as ONE bundle with no page numbers - the bytes every client sent before', () => {
    // Out of salon order on purpose: only an answer that PAGES is grouped by salon, so one that fits
    // keeps the order it was given and its bytes stay exactly the pre-paging ones.
    const one = answer([seed('b', 2), seed('a', 1), seed('b', 3)], { truncated: true });
    const pages = pageGraineBundle(one);

    expect(pages).toHaveLength(1);
    expect(pages[0].pageIndex).toBeUndefined();
    expect(pages[0].pageCount).toBeUndefined();
    expect(pages[0].truncated).toBe(true);
    expect(encodeAppMessage(mkGraineBundle(pages[0]))).toEqual(
      encodeAppMessage(
        mkGraineBundle({
          workspaceId: one.workspaceId,
          requestId: one.requestId,
          seeds: one.seeds,
          missingSessionIds: [],
          truncated: true,
        })
      )
    );
  });

  it('splits the 8 000-seed answer into pages each under the byte bound, losing and repeating nothing', () => {
    const seeds = Array.from({ length: 8000 }, (_, i) => seed(`c${i % 40}`, i));
    const whole = encodeAppMessage(
      mkGraineBundle({ workspaceId: 'w', requestId: 'r', seeds, truncated: true })
    ).length;
    // The measurement this exists for: one message of this answer is over two megabytes.
    expect(whole).toBeGreaterThan(2_000_000);

    const pages = pageGraineBundle(answer(seeds, { truncated: true }));

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages)
      expect(encodedSize(page)).toBeLessThanOrEqual(GRAINE_BUNDLE_PAGE_MAX_BYTES);
    const sent = pages.flatMap((p) => (p.seeds ?? []).map((s) => s.sessionId));
    expect(sent).toHaveLength(8000);
    expect(new Set(sent).size).toBe(8000);
    // Numbered, all under one request, and "I could not send everything" said once, at the end.
    expect(pages.map((p) => p.pageIndex)).toEqual(pages.map((_, i) => i));
    expect(new Set(pages.map((p) => p.pageCount))).toEqual(new Set([pages.length]));
    expect(new Set(pages.map((p) => p.requestId))).toEqual(new Set(['request-0123456789abcdef']));
    expect(pages.map((p) => p.truncated)).toEqual(pages.map((_, i) => i === pages.length - 1));
  });

  it('holds every page under an arbitrary budget, the wire numbers included', () => {
    const seeds = Array.from({ length: 50 }, (_, i) => seed('c', i));
    const pages = pageGraineBundle(answer(seeds), 2_000);

    expect(pages.length).toBeGreaterThan(5);
    for (const page of pages) {
      const bytes = encodeAppMessage(mkGraineBundle(page));
      expect(bytes.length).toBeLessThanOrEqual(2_000);
      // What travels decodes as the bundle that was built - the page numbers are real fields.
      expect(decodeAppMessage(bytes)?.graineBundle?.pageCount).toBe(pages.length);
    }
  });

  it("groups a salon's seeds together, so a salon is re-read by as few pages as possible", () => {
    const seeds = Array.from({ length: 40 }, (_, i) => seed(i % 2 === 0 ? 'even' : 'odd', i));
    const pages = pageGraineBundle(answer(seeds), 4_000);

    const salonsPerPage = pages.map((p) => new Set((p.seeds ?? []).map((s) => s.channelId)).size);
    // Interleaved, every page would name both salons; grouped, at most one page straddles them.
    expect(salonsPerPage.filter((n) => n > 1).length).toBeLessThanOrEqual(1);
  });

  it('pages the declines of a SESSIONS answer too, and never drops one', () => {
    const missing = Array.from({ length: 300 }, (_, i) => `missing-${i}`);
    const pages = pageGraineBundle(answer([seed('a', 1)], { missing }), 2_000);

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((p) => p.missingSessionIds ?? [])).toEqual(missing);
    for (const page of pages) expect(encodedSize(page)).toBeLessThanOrEqual(2_000);
  });

  it('still sends an entry larger than the whole budget, alone, rather than looping on it', () => {
    const pages = pageGraineBundle(answer([seed('a', 1), seed('b', 2)]), 10);

    expect(pages.map((p) => p.seeds?.length)).toEqual([1, 1]);
  });

  it('keeps "I hold nothing" on the single empty answer it belongs to', () => {
    const pages = pageGraineBundle(answer([], { holdsNothing: true }));

    expect(pages).toHaveLength(1);
    expect(pages[0].holdsNothing).toBe(true);
    expect(pages[0].seeds).toEqual([]);
  });
});
