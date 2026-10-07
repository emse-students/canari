/**
 * A title a PAGE knows and its path does not.
 *
 * `resolveSeoForPath` names a document from the URL alone, which is enough for `/institutions` and
 * not for `/associations/<slug>/edit`: whether that slug is an association or an institution is
 * data the page loads. A page must not write its own `<title>` (`seoTitles.test.ts` fails if one
 * does - the document and its preview would then disagree), so it hands the name to `SeoHead`
 * through here, and `SeoHead` stays the only writer.
 *
 * `null` means "the path's own title stands", which is also what a page restores on teardown.
 */
export const pageTitle = $state<{ current: string | null }>({ current: null });

/** Sets (or, with `null`, clears) the title the current page gives itself. */
export function setPageTitle(title: string | null): void {
  pageTitle.current = title;
}
