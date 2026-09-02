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
list is the verdict; anything else is a guess. The probe that established this was a one-shot,
removed with the harness residue; what it did is the whole of it - listen for
`securitypolicyviolation` on the page, exercise the load, and read the collected violations rather
than the element's own error.

Counting the headers is the other half, and `curl -sI` is enough: **two `content-security-policy`
lines mean the edge is injecting one.** There should be exactly one.

### The origin policy is stated once, and it is a description of the client's code

`infrastructure/local/Dockerfile.frontend` writes the policy into `/etc/nginx/snippets/csp.conf` and
every block that sets response headers pulls it in with `include`. That indirection exists because
**nginx's `add_header` REPLACES the inherited set rather than adding to it**, so each of the three
blocks that sets a header of its own (the server block, `location /`, `@app_shell`) has to carry the
whole policy - and three verbatim copies of a security policy is precisely how one of them keeps an
old value after the other two are updated. One definition makes that impossible.

`frontend/src/lib/security/csp.test.ts` asserts the invariants: exactly one declaration, more than
one `include`, both KLIPY hosts present in `connect-src`, and no bare scheme there. It lives in the
frontend suite on purpose - what invalidates the policy is frontend code calling a host nobody
added.

**The defect that produced this (2026-08-17): attaching a GIF to a post comment did nothing.**
`connect-src` named `https://api.klipy.com`, the GIF picker's search API, and nothing else. But the
picker hands back a URL on `https://static.klipy.com`, and a comment's media is end-to-end
encrypted, so the client must READ those bytes before it can encrypt and upload them. The grid
rendered normally, because `img-src` is `https:` - so the feature looked alive:

| What the picker does | Directive that governs it | Verdict before the fix |
|---|---|---|
| Search KLIPY | `connect-src https://api.klipy.com` | allowed |
| Render the grid thumbnails | `img-src https:` | allowed |
| Read the chosen GIF's bytes | `connect-src` - host absent | **blocked** |

**Displaying a remote image and reading its bytes are two different permissions.** A wide `img-src`
next to a narrow `connect-src` is the correct shape - the feed renders arbitrary user-posted image
URLs, while what the app may read into memory stays an allowlist - and it is also the shape that
makes a missing `connect-src` host look like a broken button rather than a policy.

Measured before fixing, so the allowlist is a fact rather than a guess: 1 440 media URLs across
KLIPY's trending and two searches, **all on `static.klipy.com`**. The failing request was captured
on prod against the real header - the browser names the directive itself:

> Connecting to `https://static.klipy.com/...gif` violates the following Content Security Policy
> directive: "connect-src 'self' blob: wss: ws: ... https://api.klipy.com". The action has been
> blocked.

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

## The daemon on the origin, and the token it carries

The tunnel is **remotely managed** (`config_src=cloudflare`): there is no `/etc/cloudflared/config.yml`
on the origin, and the ingress lives in the API. What the box holds is the daemon, installed from
Cloudflare's own apt repository, and a systemd unit whose `ExecStart` carries the tunnel's **run
token** in plaintext.

**That unit must be `600`.** It shipped as `644 root:root`, which is how the run token ended up in a
terminal transcript: any login user could `systemctl cat cloudflared` and read it. systemd runs as
root and never needed it world-readable, so the permission bought nothing and cost a rotation. The
unit is now `600` on the production origin and on the second tunnel host; **the Authentik host's is
still `644`**, and why it was left is in [backlog](../backlog.md#p3---the-authentik-host-still-carries-both-defects-the-other-two-had-fixed-measured-2026-09-02).

### Rotating the run token, and the order that matters

The rotation is two API calls and a unit rewrite, and it can be done from a workstation with an
account-scoped token - no dashboard gesture:

1. `PATCH /accounts/{acct}/cfd_tunnel/{id}` with `{"tunnel_secret": "<base64 of 32+ random bytes>"}`
2. `GET /accounts/{acct}/cfd_tunnel/{id}/token` for the new run token
3. rewrite the unit's `--token` argument, `daemon-reload`, `restart`

**Step 1 invalidates the old token instantly, so the ability to complete steps 2 and 3 must be
proven BEFORE step 1 runs.** Verify the credential can read `/token` first: a `PATCH` followed by a
refusal leaves a tunnel that looks healthy - the running daemon keeps the connections it already
authenticated - and dies silently at its next restart. That is not a hypothetical; it happened for
one minute during the 2026-09-02 rotation.

Two more facts that cost time:

- **A run token's length follows the secret's length.** A 32-byte secret yields ~180 characters, a
  64-byte one ~250. A plausibility check calibrated on one of them rejects the other, so any such
  guard is a numeric floor, never a digit-shaped pattern.
- **The restart tears down the session that issues it**, the tunnel being the only door. So the work
  runs detached (`setsid --fork`) and leaves a verdict in a log, and the verdict is evidence -
  `Registered tunnel connection` in the journal, then an HTTP code from the front door. A tunnel
  being up is not the site being up.

The recovery route, exercised before touching anything: the two other tunnel hosts both reach the
production origin's `:22` over the LAN, so `ssh -J <other-host> <user>@<origin-ip>` gets in when the
origin's own tunnel is down. **A fallback that has not been exercised is not a fallback** - it was
tested first, deliberately, and it is the only reason the rotation was safe to attempt.

### Nothing keeps the daemon current, and a dormant timer says otherwise

`cloudflared service install` leaves a `cloudflared-update.timer` behind. On the production origin it
is **`disabled`, `inactive`, and has never run** - no journal entries at all - while the daemon runs
with `--no-autoupdate`. The binary was three months behind (`2026.6.0` against `2026.8.3`) and
nothing said so.

**Enabling that timer would be the wrong fix.** Its `ExecStart` calls `cloudflared update`, which
replaces the binary in place and would drift it from the version `dpkg` believes is installed - the
daemon here comes from the apt repository. The package is upgraded with apt, which is safe for one
measured reason: `dpkg -S /etc/systemd/system/cloudflared.service` finds **no owner** and the package
declares **no conffile** for it, so an upgrade cannot replace the file carrying the run token. Verify
that before upgrading on any host, and compare the token's fingerprint across the upgrade so a silent
replacement is caught rather than assumed away.

## Working against the API

The account id and token are **not in this repository and must never be** - it is public. They live
in the operator's local agent memory. Read them from that file inside each command rather than
passing them as arguments, and note that an account-scoped token (`cfat_` prefix) returns
`Invalid API Token` from `/user/tokens/verify` while working perfectly everywhere else - that
endpoint is for user tokens only, so it is not a valid check of the credential.
