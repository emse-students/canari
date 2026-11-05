## P3 - a client-side navigation on Portail-etu is refused by Canari's CORS

Portail-etu loads Canari's public read-only API (`/api/public/*`: associations, lists, the carte) in
universal `+page.ts` loads (`refonte-portail-etu/src/lib/canari.ts`):

- On a first page load the SvelteKit server makes the call, and no CORS applies.
- On a CLIENT-SIDE navigation the browser makes the call with `Origin: https://portail-etu.emse.fr`.
  social-service refuses it, and the navigation fails with a bare network error ("Load failed").

Read in production on 2026-11-05: one `[Cors] CORS DENIED origin "https://portail-etu.emse.fr"`
followed by `public getPublishedCarte` and `public listAssociations`. This is rare because most visits
are first loads, but it is a real broken path.

**Fix (recommended):** the public API is public by definition. Answer `Access-Control-Allow-Origin: *`
on `GET /api/public/*` and on the public media route, WITHOUT credentials. Do not add Portail-etu to
the credentialed allowlist in `cors-origins.ts`, which exists for Canari's own clients.

**The alternative**, on the Portail-etu side, is to move the loads to `+page.server.ts`. That costs a
server round trip on every navigation and leaves any other consumer of the public API with the same
trap.

**Test:** a cross-origin `GET /api/public/associations` with an arbitrary `Origin` gets `*` and no
`Allow-Credentials`, and a credentialed route still refuses that origin.
