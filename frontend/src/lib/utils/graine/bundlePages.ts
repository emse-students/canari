import { canari } from '$lib/proto/canari';
import { encodeAppMessage, mkGraineBundle } from '$lib/proto/codec';
import { GRAINE_BUNDLE_PAGE_MAX_BYTES } from '$lib/crypto/graineConstants';

/**
 * Cuts one answer to a seed request into bundle messages, each under a byte budget.
 *
 * **Why pages need no reassembly.** A receiver stores every seed of a bundle on its own, keyed on
 * the session id, in the durable seed store (`storeIncomingSeed`): a seed already held is
 * `already-held` and changes nothing. So pages may arrive in any order and a duplicated page is a
 * no-op. A lost page corrupts nothing but is NOT free: its sessions are missing, the rows under
 * them stay hidden until the per-session repair (asked as each row fails to open) lands, and a
 * history answer missing a page is asked for ONCE more at the next start (`pagedHistoryAnswer.ts`,
 * durable, keyed on which page numbers arrived - never a timer waiting for "the rest"). The page
 * numbers are recorded for that and for the log; the absorbing of a page depends on none of them.
 *
 * Protocol and measured limits: `docs/wiki/protocols/channel-encryption.md` section 4.4 and
 * {@link GRAINE_BUNDLE_PAGE_MAX_BYTES}.
 */

/** Everything one answer says, before it is cut into pages. */
export interface GraineAnswer {
  workspaceId: string;
  requestId: string;
  seeds: canari.GraineMsg.$Properties[];
  /** Sessions the request named that the answerer does not hold. */
  missing: string[];
  /** More seeds were held than one answer may carry. Said once, on the last page. */
  truncated: boolean;
  /** A HISTORY ask answered "I hold nothing" (section 24): only ever an answer with no seed. */
  holdsNothing: boolean;
}

/** Bytes of a protobuf varint holding `n`. */
function varintBytes(n: number): number {
  let bytes = 1;
  let rest = n >>> 7;
  while (rest > 0) {
    bytes++;
    rest >>>= 7;
  }
  return bytes;
}

/** What one repeated length-delimited entry (tag + length + body) adds to its bundle. */
function entryBytes(bodyBytes: number): number {
  return 1 + varintBytes(bodyBytes) + bodyBytes;
}

/**
 * Bytes a page costs before any seed or decline: the ids, both flags, the page numbers at their
 * widest, and the `AppMessage` framing. Measured by encoding, not estimated, so a field added to
 * the bundle later is counted without anyone remembering to.
 */
function envelopeBytes(answer: GraineAnswer): number {
  const widest = 0xffffffff;
  // +3: the bundle sits inside `AppMessage` behind a length varint, one byte for this empty
  // envelope and up to four for a full page (a budget under 256 MiB).
  return (
    encodeAppMessage(
      mkGraineBundle({
        workspaceId: answer.workspaceId,
        requestId: answer.requestId,
        truncated: true,
        holdsNothing: answer.holdsNothing,
        pageIndex: widest,
        pageCount: widest,
      })
    ).length + 3
  );
}

/**
 * The bundles that carry `answer`, each encoding to at most `budget` bytes as an `AppMessage`.
 *
 * - An answer that fits is ONE bundle with no page numbers and its seeds in the order given - byte
 *   for byte the answer every client sent before pages existed, so nothing changes for a community
 *   under the budget.
 * - Otherwise every page is a complete bundle under the same `requestId`, numbered from 0;
 *   `truncated` rides the last page only, so an old reader warns once, not once per page.
 * - When it pages, seeds are grouped by salon (stable within it), so a salon's seeds land in as few
 *   pages as possible: each page that stores a new seed of a salon re-reads that salon.
 * - A page always carries at least one entry, whatever its size, so an entry larger than the
 *   budget (never expected: a seed is ~330 bytes) still travels rather than looping.
 *
 * @param budget Bytes per page; the default is {@link GRAINE_BUNDLE_PAGE_MAX_BYTES}.
 */
export function pageGraineBundle(
  answer: GraineAnswer,
  budget: number = GRAINE_BUNDLE_PAGE_MAX_BYTES
): canari.GraineBundleMsg.$Properties[] {
  const encoder = new TextEncoder();
  const envelope = envelopeBytes(answer);
  const seedCost = new Map(
    answer.seeds.map((seed) => [
      seed,
      entryBytes(canari.GraineMsg.encode(canari.GraineMsg.create(seed)).finish().length),
    ])
  );
  const missingCost = answer.missing.map((id) => entryBytes(encoder.encode(id).length));
  const base = { workspaceId: answer.workspaceId, requestId: answer.requestId };

  const total =
    envelope +
    [...seedCost.values()].reduce((a, b) => a + b, 0) +
    missingCost.reduce((a, b) => a + b, 0);
  if (total <= budget || answer.seeds.length + answer.missing.length <= 1) {
    return [
      {
        ...base,
        seeds: answer.seeds,
        missingSessionIds: answer.missing,
        truncated: answer.truncated,
        ...(answer.holdsNothing ? { holdsNothing: true } : {}),
      },
    ];
  }

  interface Page {
    seeds: canari.GraineMsg.$Properties[];
    missing: string[];
    bytes: number;
  }
  const pages: Page[] = [{ seeds: [], missing: [], bytes: envelope }];
  const place = (bytes: number): Page => {
    let page = pages[pages.length - 1];
    const empty = page.seeds.length === 0 && page.missing.length === 0;
    if (!empty && page.bytes + bytes > budget) {
      page = { seeds: [], missing: [], bytes: envelope };
      pages.push(page);
    }
    page.bytes += bytes;
    return page;
  };
  const bySalon = [...answer.seeds].sort((a, b) =>
    String(a.channelId ?? '').localeCompare(String(b.channelId ?? ''))
  );
  for (const seed of bySalon) place(seedCost.get(seed) ?? 0).seeds.push(seed);
  answer.missing.forEach((sessionId, i) => place(missingCost[i]).missing.push(sessionId));

  return pages.map((page, index) => ({
    ...base,
    seeds: page.seeds,
    missingSessionIds: page.missing,
    truncated: answer.truncated && index === pages.length - 1,
    pageIndex: index,
    pageCount: pages.length,
  }));
}
