/** The slice of the WASM client {@link mintKeyPackages} needs. */
export interface KeyPackageMinter {
  generate_last_resort_key_package(): Uint8Array;
  generate_key_packages(count: number): unknown;
  /**
   * The last-resort package the device already holds, or `undefined` if it must mint one.
   *
   * Optional so a caller that predates the reuse still type-checks and simply mints, which is the
   * old behaviour rather than a broken one.
   */
  existing_last_resort_key_package?(nowSecs: number): Uint8Array | null | undefined;
}

/** A device's published key material: one reusable fallback plus the one-time pool. */
export interface MintedKeyPackages {
  fallback: Uint8Array;
  poolPackages: Uint8Array[];
}

/**
 * Mints the two kinds of KeyPackage a device publishes, and it is the ONLY place that decides
 * which is which.
 *
 * The distinction is not cosmetic. The delivery service pops a one-time prekey when the pool has
 * one and otherwise returns the device's static row - the same bytes, to every caller, until the
 * next connection replaces it. MLS deletes an ordinary KeyPackage's private bundle as soon as a
 * Welcome built on it is processed, so a static row that is not marked last-resort can open
 * exactly one group and then locks the device out of every other group that was served it. Four
 * call sites used to mint the fallback (the worker, its two recovery branches and the main-thread
 * path); a fifth would have been one more chance to mint the wrong kind.
 */
export function mintKeyPackages(client: KeyPackageMinter, needed: number): MintedKeyPackages {
  // REPUBLISHED IF HELD, MINTED ONLY IF NOT - and the old unconditional mint was the second half of
  // the key-package leak. The pool beside it has always been incremental (`needed = 50 - existing`,
  // so nothing is minted when the pool is full) while the fallback was reminted on EVERY
  // connection, each one writing a ~2 364-byte bundle nothing deletes for 84 days to replace a
  // package that was still perfectly good. Reuse is the entire meaning of the extension: it is why
  // the delivery service can serve one package to every peer that finds the pool empty. Measured on
  // a Mi 9T on 2026-09-09: 269 last-resort bundles, 9% of a 3051-bundle keystore.
  //
  // Rotation becomes the package's own lifetime - the query returns nothing once none is valid -
  // so every 84 days instead of every time the socket comes back.
  //
  // The clock is read HERE and passed in, never inside the WASM crate: `SystemTime::now()` panics
  // on wasm32 and took every web login down in v0.16.4.
  const held = client.existing_last_resort_key_package?.(Math.floor(Date.now() / 1000));
  const fallback = held ?? client.generate_last_resort_key_package();
  const poolPackages =
    needed > 0 ? [...(client.generate_key_packages(needed) as Iterable<Uint8Array>)] : [];
  return { fallback, poolPackages };
}

/**
 * A stable identity for a key package's BYTES, used to recognise one this process published.
 *
 * NOT a hash: the bytes are already a unique public artefact (they carry a fresh init key), there
 * is no secret in them, and nothing here is a security decision - the question is only "are these
 * the same bytes I sent". A length-prefixed latin-1 string is exact, allocation-cheap, and cannot
 * collide the way a truncated digest could.
 *
 * The length prefix is what keeps it honest: without it, two different packages could in principle
 * agree on a shared prefix and differ only in length, and a Set keyed on the body alone would call
 * them the same. Cheap insurance on a comparison whose whole job is to be exact.
 */
export function fingerprintKeyPackage(bytes: Uint8Array): string {
  let body = '';
  for (let i = 0; i < bytes.length; i++) body += String.fromCharCode(bytes[i]);
  return `${bytes.length}:${body}`;
}
