import { replaceState } from '$app/navigation';
import { page } from '$app/state';

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

/**
 * Has the router's announcer read the document title again, after a page changed it on its own.
 *
 * SvelteKit's hidden route announcer (`#svelte-announcer`, `aria-live="assertive"`) copies
 * `document.title` one tick after EVERY update of the page store - and on nothing else. A page whose
 * title follows a state it learns after its navigation (the payment return: "Verification du
 * paiement..." then "Paiement introuvable") left the announcer on the first title, so VoiceOver
 * read "Verification du paiement..." over a page saying "Paiement introuvable" (iPhone 12,
 * v1.2.9-alpha.4). A shallow `replaceState` of the CURRENT url and state is the router's own way to
 * update the page store without navigating: the announcer reads the title the page now has, and
 * announces it. Call it only once the router has started - a state learned from the network is.
 */
export function announcePageTitle(): void {
  console.debug('[pageTitle] the page changed its own title, the route announcer reads it again');
  replaceState('', page.state);
}
