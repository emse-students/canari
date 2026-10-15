import { createHash } from 'crypto';

/**
 * Observation budget. The callback route is PUBLIC and its JSON/urlencoded body may reach megabytes,
 * while the search is 2^fields x algorithms x keys synchronous md5 passes: above either bound the
 * observation is SKIPPED (and says so), never truncated, so a miss is never misread as "no algorithm".
 */
export const OBSERVE_MAX_FIELDS = 10;
export const OBSERVE_MAX_BYTES = 2048;

/** A received field name reduced to what a log line may carry (the sender picks every name). */
export function logSafeFieldName(name: string): string {
  return name.replace(/[^\w.-]/g, '').slice(0, 32);
}

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

/** The ways a Lydia signature could be built; the documented one first. */
export const LYDIA_SIGNATURE_ALGORITHMS: Record<
  string,
  (names: string[], f: Record<string, string>, key: string) => string
> = {
  'sorted-pairs-and-key': (names, f, key) =>
    md5(
      [...names]
        .sort()
        .map((n) => `${n}=${f[n]}`)
        .join('&') +
        '&' +
        key
    ),
  'sorted-pairs-key-no-ampersand': (names, f, key) =>
    md5(
      [...names]
        .sort()
        .map((n) => `${n}=${f[n]}`)
        .join('&') + key
    ),
  'given-pairs-and-key': (names, f, key) =>
    md5(names.map((n) => `${n}=${f[n]}`).join('&') + '&' + key),
  'sorted-values-then-key': (names, f, key) =>
    md5(
      [...names]
        .sort()
        .map((n) => f[n])
        .join('') + key
    ),
  'given-values-and-key': (names, f, key) => md5(names.map((n) => f[n]).join('&') + '&' + key),
};

/** One way a received signature was reproduced: NAMES and algorithm only, never a value. */
export interface LydiaSignatureMatch {
  keyIndex: number;
  fields: string[];
  algorithm: string;
}

/**
 * The string fields of a received body except the signature, or why none can be tried: a value that
 * is not a string or number (an object from a JSON body) is dropped, and a body over the budget is
 * refused whole. Never throws, whatever the sender put in the body.
 */
export function observableFields(
  body: Record<string, unknown> | undefined
): { fields: Record<string, string> } | { skipped: string } {
  const fields: Record<string, string> = {};
  let bytes = 0;
  for (const [name, value] of Object.entries(body ?? {})) {
    if (name === 'sig') continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const text = String(value);
    bytes += Buffer.byteLength(name) + Buffer.byteLength(text);
    fields[name] = text;
  }
  const count = Object.keys(fields).length;
  if (count > OBSERVE_MAX_FIELDS || bytes > OBSERVE_MAX_BYTES) {
    return { skipped: `${count} field(s), ${bytes} byte(s) exceed the observation budget` };
  }
  return { fields };
}

/**
 * Finds which (key, field subset, algorithm) reproduces a received signature. OBSERVATION only:
 * the callback route keeps refusing what the Provider key does not verify, and uses this to log
 * which candidate Business key and field set Lydia really signed with (2026-10-15 measured that the
 * Provider key verifies nothing). The result carries indexes and names, never a key or a value.
 *
 * @param fields every received field except `sig`
 */
export function matchLydiaSignature(
  fields: Record<string, string>,
  signature: string,
  keys: readonly string[]
): LydiaSignatureMatch[] {
  const received = signature.toLowerCase();
  const names = Object.keys(fields);
  const matches: LydiaSignatureMatch[] = [];
  keys.forEach((key, keyIndex) => {
    for (let mask = 1; mask < 1 << names.length; mask++) {
      const subset = names.filter((_, i) => mask & (1 << i));
      for (const [algorithm, build] of Object.entries(LYDIA_SIGNATURE_ALGORITHMS)) {
        if (build(subset, fields, key) === received) {
          matches.push({ keyIndex, fields: subset, algorithm });
        }
      }
    }
  });
  return matches;
}
