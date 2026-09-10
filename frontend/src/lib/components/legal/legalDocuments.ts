import { m } from '$lib/paraglide/messages';

/** One entry in a document's table of contents, and the anchor it scrolls to. */
export interface LegalSection {
  /** The `id` of the `h2` this entry points at. */
  id: string;
  /** What the rail shows. Numbered by the document itself - the rail does not renumber. */
  label: string;
}

/** One of the three legal documents, as the footer's cross-links need it. */
export interface LegalDocumentLink {
  href: string;
  /**
   * A FUNCTION and not a string. Paraglide resolves a message against the CURRENT locale at the
   * moment it is called; a module-level constant would resolve once, at import, and freeze the
   * language the app happened to start in - which is exactly the bug a locale switch surfaces.
   */
  label: () => string;
}

/**
 * THE THREE LEGAL DOCUMENTS, LISTED ONCE.
 *
 * Each page used to hand-write links to the other two in its own footer - six links, and the pair
 * had to be edited on every page whenever the set changed. `LegalDocument.svelte` filters this by
 * the current route instead, so a page cannot link to itself and a fourth document would appear in
 * all three footers by being added here.
 */
export const LEGAL_DOCUMENTS: readonly LegalDocumentLink[] = [
  { href: '/legal/cgu', label: () => m.legal_cgu_link() },
  { href: '/legal/privacy', label: () => m.legal_privacy_link() },
  { href: '/legal/child-safety', label: () => m.legal_child_safety_link() },
];
