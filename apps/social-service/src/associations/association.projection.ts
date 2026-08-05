import { Association } from './entities/association.entity';

/**
 * Strips the two association columns that are secrets before the row leaves the service.
 *
 * `documentVaultKey` is the hex 32-byte master key of the association's document vault, from which
 * every per-document CEK is derived (`deriveDocumentCekHex`); `notesCiphertext` holds the
 * association's private notes. Both were reaching clients because the read paths spread the whole
 * entity (`{ ...asso, memberCount }`), and the three routes that do so carry no guard at all - so an
 * unauthenticated request could enumerate every vault key on the platform.
 *
 * Same lesson as `Channel.masterSecret` and `AssociationProduct.webhookSecret`: an entity that
 * carries a secret needs one seam that removes it, and every read has to pass through it.
 *
 * Nulls rather than deletes, so the response keeps the shape its TypeScript clients expect - and so
 * a caller reading `documentVaultKey` gets "absent" rather than a missing property. The seam is the
 * CONTROLLER, not the service: `findById` is also used internally by writers (`update`), and a
 * service-level strip would feed them a row whose key column reads null.
 */
export function toSafeAssociation<T extends Partial<Association>>(
  association: T
): Omit<T, 'documentVaultKey' | 'notesCiphertext'> & {
  documentVaultKey: null;
  notesCiphertext: null;
} {
  // Omit before intersecting: a bare `T & { documentVaultKey: null }` collapses to `never` as soon
  // as T types that column as a non-nullable string.
  return { ...association, documentVaultKey: null, notesCiphertext: null };
}
