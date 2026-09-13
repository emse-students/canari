/**
 * Reads the metadata markers a document vault stores at the head of
 * `association_documents.description`: the per-document HKDF salt the CEK is derived from,
 * and the PBKDF2 salt of a password-protected document.
 *
 * **SECOND COPY, ON PURPOSE.** The first is `parseVaultMarkers` /
 * `buildVaultMarkers` in `frontend/src/lib/associations/vaultCrypto.ts`, which WRITES
 * these markers; this side only ever reads them. There is no shared TS package to hold one
 * implementation, and creating one to save twenty lines is the trade `docs/wiki/libs.md`
 * already refused when `@canari/shared-ts` was deleted (2026-08-27).
 *
 * The duplication has been paid for once, in full: the client moved from `[s:...]` to
 * `(s:...)` on 2026-07-24 - so Tailwind's JIT scanner would stop reading the brackets as an
 * arbitrary CSS property class - and this side was not moved with it. Every public document
 * uploaded afterwards carried a marker the server could not parse, and the reviewer page at
 * `/documents` served an empty list for seven weeks. **A change to the marker format lands in
 * BOTH files, in the SAME commit.**
 *
 * Unlike the frontend copy, nothing here is scanned by Tailwind (its source detection starts at
 * `frontend/`), so the legacy bracket patterns are written as plain regex literals rather than
 * being assembled at runtime to hide them.
 */

/** The markers carried by one document's `description`. */
export interface VaultMarkers {
  /** Per-document HKDF salt the CEK is derived from; null when no marker is present. */
  cekSalt: string | null;
  /** PBKDF2 salt of a password-protected document; null when the document is not protected. */
  pwSalt: string | null;
}

/** Current syntax, written by the client since 2026-07-24. */
const CEK_SALT = /^\(s:([^)]+)\)/;
const PW_SALT = /\(pw:([0-9a-f]+)\)/;
/** Syntax written before 2026-07-24, still present on rows uploaded then. */
const CEK_SALT_LEGACY = /^\[s:([^\]]+)\]/;
const PW_SALT_LEGACY = /\[pw:([0-9a-f]+)\]/;

/**
 * Extracts both markers from a document description, accepting the current parenthesis syntax
 * and the legacy bracket one. The CEK salt is read only from the START of the description,
 * which is where the client writes it; the password salt may follow it.
 *
 * @param description - the raw `association_documents.description` column, which may be null.
 */
export function parseVaultMarkers(description: string | null | undefined): VaultMarkers {
  return {
    cekSalt: description?.match(CEK_SALT)?.[1] ?? description?.match(CEK_SALT_LEGACY)?.[1] ?? null,
    pwSalt: description?.match(PW_SALT)?.[1] ?? description?.match(PW_SALT_LEGACY)?.[1] ?? null,
  };
}

/**
 * True when the document is password-protected. Such a document can never be exposed to a
 * reviewer: its CEK folds in a PBKDF2 hash of a password the server never receives, so no
 * server-side derivation could produce a usable key.
 *
 * @param description - the raw `association_documents.description` column, which may be null.
 */
export function isPasswordProtected(description: string | null | undefined): boolean {
  return parseVaultMarkers(description).pwSalt !== null;
}
