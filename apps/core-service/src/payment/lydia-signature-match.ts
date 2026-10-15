import { createHash } from 'crypto';

/** Most received field names tried as subsets: 2^12 subsets x the algorithms stays instant. */
const MAX_FIELDS = 12;

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
  const names = Object.keys(fields).slice(0, MAX_FIELDS);
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
