import { SvelteURL } from 'svelte/reactivity';

/**
 * A REACTIVE `page.url` for a test that navigates between two queries of the SAME route: SvelteKit
 * reuses the mounted component, and only a reactive url lets the test drive what a real navigation
 * drives. The test's `$app/state` mock returns it from a getter; navigate by assigning `.href`.
 */
export const routeUrl = new SvelteURL('https://canari.test/login');
