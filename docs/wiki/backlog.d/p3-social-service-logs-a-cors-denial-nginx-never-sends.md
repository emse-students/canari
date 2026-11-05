## P3 - social-service logs `CORS DENIED` for `/api/public/*` calls that nginx answers with `*`

Read in production on 2026-11-05: `[Cors] CORS DENIED origin "https://portail-etu.emse.fr"`, followed by
`public getPublishedCarte` and `public listAssociations`. Portail-etu's universal `+page.ts` loads call
the public API from the browser on a client-side navigation.

**Nothing was refused.** nginx answers CORS for `location /api/public/` by itself
(`infrastructure/local/Dockerfile.frontend`, about lines 813-831):

- it hides the upstream `Access-Control-Allow-Origin` and `Access-Control-Allow-Credentials` headers;
- it sends `Access-Control-Allow-Origin: *`.

`curl -H "Origin: https://portail-etu.emse.fr" https://canari.emse.fr/api/public/associations` reads
`200` and `Access-Control-Allow-Origin: *`.

The warn line comes from social-service's global `corsOriginDelegate` (`cors-origins.ts`, wired once in
`main.ts`). That delegate judges a route nginx owns. The line claims a browser failure that cannot
happen: it is noise, and a reader would chase it.

**Fix:** the delegate must not judge `/api/public/*`. That path has one CORS layer, nginx's, so the line
names nothing. Silence it there by construction, for example by passing the request path to the
delegate and skipping the public prefix. Do not demote the line for every route, because on a
credentialed route it is a real refusal.

**Test:** a request to a public route with a foreign `Origin` logs no denial, and a credentialed route
with the same origin still logs it.
