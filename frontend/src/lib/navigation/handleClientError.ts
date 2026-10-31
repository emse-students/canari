import type { HandleClientError } from '@sveltejs/kit/hooks';
import { match } from '$app/paths';

/**
 * THE ONE PLACE A PAGE CRASH IS REPORTED - a load that throws and a page that throws while it renders.
 *
 * SvelteKit 3 wraps every route node in its own `<svelte:boundary>`, armed with the root
 * `+error.svelte` and closer to the page than anything the root layout can draw, and runs what it
 * catches through this hook (`transformError` on the client root). So the boundary the root layout
 * used to hold around `children` - the one that wrote `[Layout] page crash on <route>` - can never
 * fire under Kit 3, and was deleted with this module: a second copy of the report would be a second
 * place to keep in step, and the one Kit does not call is the one that rots.
 *
 * The line names the ROUTE ID, never the URL: the in-app log has no address bar, and a route id
 * (`/posts/[postId]`) says which page without carrying the member or the post it was opened on.
 * The level follows the status: a 4xx is a correct answer about the address (a warning), and an error
 * nobody named (`unknown`) or a 5xx is this application failing. `console.error` is what enters the
 * in-app log (`appLog.ts`) at its error letter.
 *
 * THE ROUTE IS MATCHED FROM `event.url`, NOT READ FROM `event.route`. Kit 3.1.0 builds the event
 * it hands a boundary error from the state BEFORE the first navigation (`initialize` reads
 * `current.route` before assigning it), so until the reader's first client navigation every crash
 * arrives with `route.id === null` - read on the static build: `[App] page crash on ?` for a page
 * opened directly. Its `url` is right in every case (the location at start, the target on a
 * navigation), so the route table is asked about that one field. `?` is an address no route matches.
 *
 * Nothing is returned, so SvelteKit's own status and safe message stand.
 */
export const handleClientError: HandleClientError = async (caught) => {
  const route = (await match(caught.event.url))?.id ?? '?';
  const status = caught.kind === 'unknown' ? 500 : caught.error.status;
  if (status < 500) {
    console.warn(`[App] navigation error ${status} on ${route}:`, caught.error);
    return;
  }
  console.error(`[App] page crash on ${route}:`, caught.error);
};
