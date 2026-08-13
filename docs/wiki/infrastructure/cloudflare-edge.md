# Cloudflare edge

**Source of truth: the Cloudflare zone itself.** That is the problem this page exists to contain -
the edge is production infrastructure with no representation in git, so nothing in a review, a test
run or a deploy can see it change. It is configured by hand in a dashboard, and a hand-made change
there outranks everything in this repository.

Related: [nginx](nginx.md) (the origin behind it), [docker](docker.md).

## Topology

Every hostname on the zone is a **proxied CNAME to a Cloudflare Tunnel** (`*.cfargotunnel.com`), so
there is no public IP and no inbound port on the origin. `cloudflared` forwards to
`http://localhost:8080` -> nginx:80.

One consequence worth stating, because it is the opposite of the usual advice: the zone's **SSL/TLS
mode is not a meaningful control here**. There is no classic edge-to-origin TLS connection to make
strict - the tunnel is its own authenticated transport, and what `cloudflared` does on the far end is
decided by the tunnel's ingress rules, not by the zone setting. Raising it from Full to Full (strict)
buys nothing and can break the tunnel.

## Who owns a response header

**Nginx owns every response header, including `Content-Security-Policy`. The edge adds none.**

This is a rule, not a description, and it was written after the incident below.

A Transform Rule was added to the zone on 2026-08-12 with `operation: add` and the description
"CSP permissive", intending to loosen the policy. It did the exact opposite, and would always have
done the exact opposite:

> **A browser enforces every CSP header it receives INDEPENDENTLY. The effective policy is their
> INTERSECTION. A second policy can therefore only ever REMOVE permissions - it is structurally
> incapable of granting one.**

So a rule whose only possible effect is to restrict was named for the opposite of what it could do,
and every reading of it in the dashboard confirmed the wrong intention.

What it removed, specifically, is the trap worth remembering: **`*` matches network schemes only.**
It does not cover `blob:`, `data:` or `filesystem:`. The added policy declared `connect-src *`,
`worker-src *` and `media-src *`, so against an origin policy that explicitly allows `blob:` in all
three, the intersection forbade it:

| Operation from a `blob:` URL | Before | After removal |
|---|---|---|
| `fetch()` | blocked | allowed |
| `XMLHttpRequest` | blocked | allowed |
| `new Worker()` | blocked | allowed |
| `<img src>` | allowed | allowed |

`<img>` survived only because the added policy happened to spell `img-src * data: blob:` in full.
That is what made the failure look arbitrary from the outside: media previews rendered, so the CSP
looked fine, while three other capabilities were gone.

### How to measure this, and the reading that settles it

Every indirect signal here is ambiguous, and two of them nearly produced a wrong conclusion:

- a blocked `fetch` and an unreachable network **both** throw `TypeError: Failed to fetch`;
- a refused `<video>` reports `MEDIA_ERR_SRC_NOT_SUPPORTED` (code 4) - **the same code an
  unplayable codec reports.** A probe built on a hand-made 24-byte MP4 therefore reports "blocked"
  whether or not CSP had anything to do with it.

Only the browser's own `securitypolicyviolation` event names the directive that refused, so it is
the one reading that distinguishes "CSP said no" from "this happened to fail". An empty violation
list is the verdict; anything else is a guess. `../canari-harness/probe-csp-blob.mjs` is built
around it.

Counting the headers is the other half, and `curl -sI` is enough: **two `content-security-policy`
lines mean the edge is injecting one.** There should be exactly one.

## Administrative hostnames are gated by Cloudflare Access

Every administrative interface published through a tunnel sits behind **Cloudflare Access**, in front
of the application's own login. One reusable Access **group** holds the allowlist and every
application references it, so adding or removing an administrator is one edit in one place rather
than one per hostname.

**Which hostname serves which product is deliberately not written here** - this repository is public,
and a gated door still does not need a signpost. The inventory lives in the operator's local agent
memory alongside the API credentials.

Two things learned doing it, both general:

- **THE ACCOUNT IS THE UNIT OF AUDIT, NOT THE ZONE.** This account carries three zones and three
  tunnels. Auditing the one zone that prompted the question left an administrative interface fully
  open on another, and the DNS listing of the first zone could not have revealed it.
- **A SECOND HOSTNAME CAN NAME THE SAME DESTINATION, AND GATING ONE GATES NOTHING.** Two hostnames
  on two different zones resolved to the identical `https://10.0.0.2:8006` origin. The **tunnel
  ingress table is the authoritative list of what is published** - `GET
  /accounts/{account}/cfd_tunnel/{id}/configurations` - because it maps hostname to *service*, which
  is what makes the duplicate visible. A DNS listing shows names, not destinations, so it cannot.

Before gating anything, check what already calls it **by that public name**: an internal consumer
reaching a service by its private address is unaffected, one reaching it by its public hostname
breaks the moment Access is applied. `docker inspect <container> --format '{{range .Config.Env}}...'`
answers it, and the answer decides whether the change is safe rather than being assumed.

## Settings that are deliberate

Read the live values with `GET /zones/{zone}/settings`; these are the ones with a reason attached.

| Setting | Value | Why |
|---|---|---|
| `min_tls_version` | `1.2` | Was `1.0`. TLS 1.0/1.1 are deprecated and offer nothing here - every browser and both mobile runtimes have done 1.2 for a decade |
| `email_obfuscation` | `off` | It rewrites addresses inside HTML responses and injects a `/cdn-cgi/` script to undo the rewrite. Free mutation of SSR output that renders user content, for no benefit on a site behind auth |
| `websockets` | `on` | Required by `/api/ws` |
| `rocket_loader` | `off` | It defers and re-orders scripts, which breaks SvelteKit hydration |
| `browser_cache_ttl` | `14400` | **Left alone on purpose.** It looks like it should override the origin's `max-age=31536000, immutable` on `/_app/immutable/`, and it does not - measured through the edge, the origin's value arrives intact. The theory was refuted, so the setting stays |
| `ssl` | `full` | See the tunnel note above - not a meaningful control on this zone |
| `0rtt` | `off` | 0-RTT permits replay of early data |

## Zone rulesets

Four zone-level rulesets carry rules. `http_response_headers_transform` is **empty and must stay
empty** - see above.

| Phase | Rule |
|---|---|
| `http_response_headers_transform` | *(none - deliberate)* |
| `http_request_dynamic_redirect` | `www.` -> apex, 301 |
| `http_config_settings` | BIC disabled on the auth subdomain |
| `http_request_cache_settings` | cache bypassed on the auth subdomain |

## Working against the API

The account id and token are **not in this repository and must never be** - it is public. They live
in the operator's local agent memory. Read them from that file inside each command rather than
passing them as arguments, and note that an account-scoped token (`cfat_` prefix) returns
`Invalid API Token` from `/user/tokens/verify` while working perfectly everywhere else - that
endpoint is for user tokens only, so it is not a valid check of the credential.
