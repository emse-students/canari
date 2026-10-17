# The estate migration - three VMs onto one host, then onto `emse.fr`

**This page is the public summary.** The operating detail of the migration (host and network map,
access routes, firewall and intrusion-prevention behaviour, accounts, certificate and DNS
exchanges, per-service move logs) is an access map for infrastructure this project does not own, and
is kept in the operators' private notes. What stays here is what was decided and the traps that
bind code.

Related: [cloudflare-edge](cloudflare-edge.md), [nginx](nginx.md), [dev-environment](dev-environment.md),
[host-updates](host-updates.md).

## 1. What is moving, and the two phases

Production, the dev estate, Le Cercle and the identity provider (MiConnect) ran on three small VMs
behind Cloudflare tunnels. They were consolidated, on 2026-09-24, onto ONE school-managed Docker host
(phase 1), and the public names then moved from `canari-emse.fr` to `canari.emse.fr` and its siblings
under `emse.fr` (phase 2). Every service binds loopback on the host; the host's own nginx terminates
TLS and routes by `Host`. No Cloudflare connector runs on the host.

## 2. The measured starting point (2026-09-23)

The target is a shared host: co-tenant sites, human accounts and a school-owned security stack live
beside ours, and its capacity (CPU, RAM, a disk that cannot be grown from here) was smaller than the
three VMs it absorbs. **The move rebuilds from the compose files, so debris is dropped by NOT being
recreated.** Host-specific measurements are in the private notes.

### The host was emptied before the move - 2026-09-24, and it is DONE

Unused legacy software on the host (old language runtimes, a database server with no remaining
traffic, desktop libraries) was removed after evidence that nothing used it. Rule: **check the STATE
after each batch, never the exit status**, delete what would have talked to a removed service in the
same step, and leave in place anything that is the only surviving copy of a repository.

## 3. The bun blocker is refuted

A suspected runtime blocker for the target was measured and refuted; it is not to be re-opened.

## 4. The decisions - taken with the user 2026-09-23 and 2026-09-24, not to be relitigated

No Cloudflare in the public path of the new names; one certificate per name, issued by the school;
the dev estate is hosted on the same machine; each estate moves by verified copy.

## 5. The target shape, and the one thing it forces

Only 22, 80 and 443 enter the host (the filter is the school's network border, not the host's own
rules). Every container port stays on loopback and nginx is the only entry.

### What the edge did that the origin must now do

Removing the CDN moves its jobs onto the origin: real client addresses, compression, WebSocket
upgrade settings, caching of the app shell and a redirect for the legacy names. Each one that was
not ported broke something; port them explicitly.

#### CROWDSEC COVERS THIS HOST IN TWO HALVES, AND ONLY ONE OF THEM REACHES EVERY VHOST

The in-line bouncer and WAF apply to every server block; the log-parsing scenarios only read the log
files they are told about. **Rule: set `real_ip` (the trusted proxy's address, `real_ip_header
X-Forwarded-For`, `real_ip_recursive on`) on a vhost BEFORE pointing log-parsing protection at its
log.** Otherwise one address stands for every visitor, and the first abusive request bans the proxy
and takes the whole name down. The trusted address is the CONNECTOR's, not the origin service's old
host. Bans are global per address on a shared host.

#### REFUTED - an nginx `proxy_cache` substitute for the lost edge cache buys ~3 ms of an ~80 ms path

Measured and refuted; not worth building.

#### THE LEGACY HOSTNAME WAS ANSWERING 502 AT THE ORIGIN AND THE EDGE CACHE HID IT, 2026-09-25

A CDN cache can hide an origin that fails. Probe the origin directly after any move, not the public
name.

### THE FRONTEND BAKES ONE ABSOLUTE ORIGIN PER BUILD, AND PHASE 2 GAVE IT TWO - LOGIN BROKE, 2026-09-25

SvelteKit bakes `import.meta.env.*` at build time, so a second public name needs either its own build
or origin-relative URLs. Check every absolute URL a build carries against every name that serves it.

### THE CERTIFICATE RENEWAL IS THE TRAP, AND IT IS NOT HYPOTHETICAL

Certificates are delivered by the school, not by ACME. Treat renewal as an external event: verify
the certificate actually served and never assume it was renewed.

## 6. Phase 1 - the move

The runner account change and the per-service moves followed one template. The traps that bind code:

### The network shape, settled 2026-09-24 - only 22, 80 and 443 enter the target, from anywhere

Measured with a control: a high port published by a container was reachable from the host itself but
not from outside, while 22, 80 and 443 answered. The filter is the school's network border, so every
service stays on loopback behind the host's nginx and nothing else is exposed or can be relied on to
be reachable (for example, no inbound UDP range).

### `cercle` HAS MOVED - 2026-09-24, AND IT IS THE SHAPE THE OTHER TWO FOLLOW

A copy, a verification against the old estate, then the traffic switch; rollback stays one line on
a machine we own.

### `miconnect` - MOVED 2026-09-24, BY HAND, BECAUSE NOTHING DEPLOYS IT

The identity provider's stack is deployed by hand; its configuration is code and applied by the
release ([authentik](authentik.md)).

### `canari` - MOVED 2026-09-24: it was two estates and a CI runner, not one estate

Production, dev and the self-hosted runner shared one box; they are now separated by compose project
and by working directory. The runner runs as a dedicated unprivileged account, one install directory
per repository.

### THE MOVE WAS FINISHED BY HAND, SO THE FIRST AUTOMATED DEPLOY TOOK PRODUCTION DOWN - 2026-09-25

**Rule: do not tidy the production frontend host port back to its old value.** The old default
collided with a service already bound on the shared host, and the first automated deploy after the
move failed to bind. The port is computed in `infrastructure/deploy/render-env.sh`, defaulted in
`deploy-environment.sh`, and the reserved list in `deploy-env.test.sh` is measured on the host, not
derived. A manual move must be followed by a change to every file that still encodes the old value.

## 7. Phase 2 - the names

Names are requested from the school as DNS records (no delegated zone, no wildcard), one batch per
request. The legacy names redirect documents and keep serving `/api/`, `/.well-known/` and an open
tab's assets.

### Sky MOVES, the wiki and Omeka only get names - decided by the user 2026-09-25

Sky moves to the shared host; the wiki and the archive only receive new names.

#### Sky moved, 2026-09-27

Done; verified through the new name and the legacy path.

### The deep links are the one thing a redirect cannot fix

A redirect from the legacy name cannot preserve a native app's association with it; association files
must be served from the new name.

### A browser cannot follow a redirect and keep its state - AND THE USER TOOK THAT COST KNOWINGLY, 2026-09-25

Origin-bound state (IndexedDB, storage, cookies) does not follow a redirect across origins. The user
accepted that cost for the legacy name, which therefore serves apps only.

### THE NAME IS NOT IN THE CODE OF THE OTHER FOUR PROJECTS - IT IS AN ENVIRONMENT VARIABLE, AND MOVING THE DEFAULT REACHES NOTHING, 2026-09-25

The public name of Canari is an environment variable in each sibling project; changing the default
in this repository reaches none of them. Change each deployment's variable.

### The OIDC issuer

The issuer keeps its legacy host name until the identity provider's own move; after any rename, test
the sign-in callback end to end.

#### THE OLD NAME OF MICONNECT REDIRECTS, AND THE DSI REPLACED THE CAS CALLBACK (2026-10-06)

The school's IT department replaced, rather than extended, the CAS callback of the identity
provider. After any callback change, sign in end to end.

## 8. What is owed by the USER

Pointers only; see [backlog](../backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks).

## 9. Open questions

Kept in the private notes.

## 10. THE ORDERED LIST - written 2026-09-24, DATA AND TRAFFIC NOW DONE FOR ALL THREE ESTATES

Data and traffic moved for all three estates; what remains is names and cleanups.

## The SEO pass: one indexable page per site (2026-10-06)

Each site exposes one indexable presentation page (absolute URLs from the request origin, JSON-LD
with `<` and `&` escaped, `robots.txt` allowing only `/$`, `X-Robots-Tag: noindex, nofollow` as the
second voice). A thrown `redirect()` bypasses `resolve`, so each handler catches `isRedirect`.

## What this project installed on the shared host, and what the DSI must map (2026-10-09)

The host is the school IT department's: no install, removal or security setting is made on it
without their written agreement, asked BEFORE ([durable-rules](../durable-rules.md)). The list of what
this project installed (container runtime, runner accounts, units, cron entries, directories) was
handed to the DSI for their audit and is kept in the private notes.
