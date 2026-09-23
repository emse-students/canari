# The estate migration - three VMs onto one host, then onto `emse.fr`

**This page is the only copy of the plan.** The decisions below were taken with the user on
2026-09-23 and are marked not to be re-litigated; everything else here is either a MEASUREMENT with
its date, or an OPEN QUESTION with the person who owes the answer.

Related: [cloudflare-edge](cloudflare-edge.md) (what the edge does today, and stops doing),
[nginx](nginx.md) (the origin behind it), [docker](docker.md),
[dev-environment](dev-environment.md), [authentik](authentik.md),
[ecosystem-convergence](../ecosystem-convergence.md).

## 1. What is moving, and the two phases

Three Proxmox VMs - `canari`, `cercle`, `miconnect` - become three Docker compose projects on the
machine that already serves Portail-etu. Then four public names move from a domain we own to the
School's.

**THE PHASES ARE SEPARATE BECAUSE ONLY ONE OF THEM IS VISIBLE.** Phase 1 changes where bytes
execute and nothing else: same names, same certificates, same edge, so a member cannot tell it
happened and a mistake is undone by pointing the tunnel back at a VM that is still running. Phase 2
changes what a user types, what a mobile binary has compiled into it, and what an OIDC token says
it was issued by - none of which a tunnel can undo. Doing them together would make every phase-2
symptom indistinguishable from a phase-1 one.

| | Phase 1 - the move | Phase 2 - the names |
| --- | --- | --- |
| Changes | execution host, compose topology | public hostnames, TLS, OIDC issuer, deep links |
| Visible to a member | no | yes, and irreversibly on mobile |
| Rollback | repoint the tunnel at the old VM | redirects only; a shipped binary cannot be recalled |
| Cloudflare | unchanged | **gone from every public path** |

## 2. The measured starting point (2026-09-23)

### The three VMs

| VM | vCPU | RAM | Disk | Contents |
| --- | --- | --- | --- | --- |
| `canari` (pve 101) | 6 | 16 G | 125 G, **49 G used** | 23 containers: production AND dev, one daemon, two compose projects |
| `cercle` (pve 102) | 1 | 2 G | 12 G, 6.1 G used | 1 container |
| `miconnect` (pve 103) | 1 | 2 G | 16 G, 5.5 G used | Authentik: server, worker, postgresql |

### THE DATA IS TINY, AND THAT IS WHAT DECIDES THE CUTOVER

Measured with `docker system df -v` on `canari`:

| Volume | Size |
| --- | --- |
| `infrastructure_garage_data` (production media) | 67.97 MB |
| `infrastructure_redis_data` | 66.42 MB |
| `infrastructure_garage_meta` | 5.70 MB |
| `canari-dev_postgres_data_18` | 216.2 MB |

Production's Postgres volume was not read in that pass and is owed a number before the runbook is
written; dev's is a full copy of it, so the order of magnitude is settled even though the figure is
not. **The whole live state is comfortably under a gigabyte.** A dump, a copy and a restore is
therefore MINUTES, which is why no logical replication, no dual-write and no read replica appears
anywhere in this plan. A short read-only window is the entire cutover.

### 49 G, and roughly 33 G of it is not production

| What | Size | Verdict |
| --- | --- | --- |
| `/home/canari/migallery-offsite` | **16 G** | MiGallery's offsite backup, living on Canari's VM. Largest single item, and unrelated to Canari |
| Docker images | 19.83 G, **14.71 G reclaimable (74%)** | 86 images for 23 containers. No `prune` has ever run |
| `/home/canari/actions-runner` | 5.5 G | runner plus build caches |
| `.rustup` + `.cargo` | 1.9 G | a Rust toolchain on a production box |
| `/var/log/journal` | 1.1 G | no cap set |
| Orphaned volumes | ~1.2 G | including `zookeeper_logs` (134 MB) and `miconnect_database` (292 MB), **0 links each** |

**Do not migrate this.** The move rebuilds the estate from its compose files, so debris is dropped
by NOT being recreated rather than by being deleted. Two of those lines are also questions nobody
has asked: `zookeeper` has two volumes and no container, and Authentik's database volume is sitting
on the wrong VM entirely.

### The target host

`portail-etu.emse.fr`, `193.49.175.67`, reached by `ssh portail-etu` through `ProxyJump bastion`.

- The login is **`jolan.boudin`**, and it is now proven ON THE HOST ITSELF, not just on the
  bastion: a shell was reached 2026-09-23. **`boudin` is a SEPARATE, older account** that refuses
  both of this workstation's keys - the FIDO one and `id_ed25519` - tried once each and not again,
  because the host counts failed authentications (see the security agents below). It is that older
  account, not ours, that carries the `docker` group: **the rights did not follow the new account.**
- The key is `id_ed25519_sk`, a **FIDO authenticator requiring a physical touch**, so no unattended
  process can SSH there. **`ControlPersist` IS NOT THE LEVER, and nothing here may lean on it** -
  measured on this workstation 2026-09-23 and REFUTED. The master starts, it daemonises, and
  `ssh -O check` reports `Master running`; every client that presents itself is nonetheless reset
  and silently falls back to a fresh connection. The tell is the clock: 7 to 10 seconds and one
  touch per command, where a reused socket costs about 20 ms. MSYS emulates the Unix domain socket
  over Windows and multiplexing does not survive the emulation; native Windows OpenSSH does not
  implement `ControlMaster` at all, so no configuration fixes this. **The working shape is ONE
  batched command per round of investigation, never a sequence of small ones** - each small one
  spends a human gesture.
- **This does not constrain CI.** Portail-etu deploys from a self-hosted runner installed ON the
  box, which pulls the code itself. The same shape is what Canari, le Cercle and Authentik will
  use, so no deploy path ever needs SSH.
- `canari.emse.fr` **already resolves**, to `193.49.175.122`, and serves Portail-etu byte for byte
  (identical `ETag`). The name has to be reclaimed, not created. **That it is a second address of
  the SAME machine is an inference, not a measurement, and one probe now sits against it**: from
  inside EMSE, `193.49.175.67:22` answers an SSH banner while `193.49.175.122:22` is dropped. A
  per-address firewall rule explains that as easily as two hosts do, so it refutes nothing - but
  the claim is not to be repeated as fact until something settles it.

### WHAT THE HOST ACTUALLY IS - MEASURED ON IT, 2026-09-23

Everything above was inferred from the outside. A shell on the box says something different, and it
changes what this chantier is.

**It is not a Portail-etu server. It is the school's shared association-hosting box**, and it has
been one for years: `gala.emse.fr`, `handimines.emse.fr` and `mep.emse.fr` are served beside
Portail-etu from `/etc/nginx/sites-enabled/`, with MySQL, postfix, NFS mounts and **six concurrent
php-fpm versions** (7.4 through 8.4) underneath, plus roughly a dozen human accounts. **We are
moving in beside other associations, not onto an empty host**, which is a constraint on every
decision below and was not priced into section 4.

**Debian 13 (trixie)**, kernel 6.12, KVM guest. Docker 26.1.5 and containerd are running, and a
**self-hosted GitHub Actions runner for `emse-students` is already installed** - the deploy shape
this plan wants exists in part.

**The host nginx is real and it terminates TLS.** Ports 80 and 443 listen on `0.0.0.0` while the
application sits on `127.0.0.1:3000`, which is exactly the shape section 5 assumes. An earlier
reading that TLS terminated inside a container was wrong: it tested `command -v nginx` against an
unprivileged login's `PATH`, which does not carry it, and read the absence as an answer.

**The certificate convention is answered**: `/etc/certs/<name>/`, **one directory per name**, not a
shared SAN. And `/etc/certs/canari.emse.fr/` together with `sites-enabled/canari.conf` were both
created on 2026-09-22 - **the DSI started preparing phase 2 while this plan was being written.**

| | Target host | The three VMs to absorb |
| --- | --- | --- |
| vCPU | **4** (QEMU, AVX2 present) | 8 |
| RAM | **11 G**, 1.6 in use | 20 G allocated |
| Disk | **50 G, fully partitioned, no LVM**; 25 G free | 49 G, of which ~33 G is debris that does not move |

**The disk cannot be grown from here.** `sda` is 50 G, `sda1` takes 46 and `sda5` is 4 G of swap;
with no LVM, enlarging it is a DSI action on the VM, not a command. Of the 18 G in use, **2.6 G is
the systemd journal** - reclaimable, but not by us.

**AND THE ACCOUNT CANNOT DO ANYTHING.** `jolan.boudin` is in no group but its own and `users`: no
`sudo`, no `docker`, and `/var/lib/docker` is unreadable, which is why the disk breakdown above
stops at 9 of the 18 G. **The migration cannot start until this is granted**, and it is the first
line of the request in section 8.

**The host runs DSI-managed security agents that ban a source IP on failed authentication and on
scans.** Two consequences, both binding: **never sweep ports and never retry a login in a loop**,
and remember that the source address they see is production's, because the only route in is
`ProxyJump canari`. A careless probe bans the estate's own IP. What those agents are is a matter for
the operator's local notes, not for a public repository.

**THE BASTION KEEPS OFFICE HOURS, AND THAT IS THE WHOLE OF IT.** `bastiono-ssh.emse.fr` is up
**07:00 to 20:00 only, and accepts French source addresses only** - stated by the DSI on 2026-09-23
at 22:31, in answer to the question. It is not down, it was never misconfigured, and **nothing about
it needs reporting**.

Two readings died on the way to that one sentence, and the order matters more than either. The
first, **that we had been banned by fail2ban after two failed logins, is REFUTED**: a ban cannot
silence an address that never tried, and the same silence came back from four distinct sources. The
second, **that the host was therefore DOWN, was right about the symptom and wrong about the cause**
- and the evidence offered for it was weaker than it looked, because the "freshly-rented VPN exit
with no history" was almost certainly not French either, so it fell foul of a second rule rather
than corroborating the first. **The measurement that actually carried the answer was the cheapest
one: the SAME address answered in the morning and was refused at night.** A probe from a new source
adds nothing when the variable that moved was the clock.

So the operational rule is a schedule, not a workaround: **through the bastion between 07:00 and
20:00; outside those hours, `portail-etu-direct`**, which reaches `193.49.175.67` by
`ProxyJump canari`. That route works at any hour **only because `canari` is inside EMSE** and leaves
on a private address - the DSI confirms egress in RFC1918 through the school passes - since the
host's port 22 is dropped for every address outside it. This workstation's home address will NOT be
allowlisted, and was not asked to be: the school route makes it unnecessary.

## 3. THE BUN BLOCKER IS REFUTED - do not re-open it

For one day this plan had a blocking question. It is recorded because the refutation is what makes
the plan safe rather than lucky.

Portail-etu's `deploy.yml` carried, at length, the reason its `.bun-version` sat at **1.3.8**: the
host is a KVM guest whose CPU advertised **no AVX2**, and every bun from 1.3.9 to 1.3.14 span at
100% CPU inside module load - before the first log line, before a port was bound - which is what
took Portail-etu's production down on 2026-08-26. Canari's four NestJS services build and run on
`oven/bun:1.4.2-alpine`. **Docker does not virtualise instruction sets**, so a container's bun
executes on the host's CPU and would have hung identically; updating bun on the HOST would have
proved nothing, because each image carries its own.

**The CPU now has AVX2, and the question is closed by a commit rather than by an argument**:
Portail-etu `dcc9ffb`, 2026-09-22, *"Update Bun from 1.3.8 to 1.4.2 now that the deploy host has
AVX2"*. The target host therefore already runs, in production, the exact bun Canari's images carry.

One drift found on the way and still open: `.bun-version` says `1.4.0` while all seven Dockerfiles
say `1.4.2`.

## 4. The decisions - taken with the user 2026-09-23, NOT TO BE RELITIGATED

| Decision | Value | Why |
| --- | --- | --- |
| Shape on the new host | **Docker compose projects side by side**, not nested virtualisation | simpler, and it is the shape every future project gets |
| Public traffic | **No Cloudflare at all** - nginx, ufw and DSI certificates | the School owns the zone and will not delegate it |
| Internal traffic | stays on **`rootz-emse.fr`** behind a Cloudflare tunnel, with Access | an admin interface does not need a public name, and a gated door does not need a signpost |
| The tunnel | **a new one**, not the existing one moved | cleaner than carrying years of ingress across |
| Dev | **`dev.canari.rootz-emse.fr`**, internal, behind the tunnel | dev holds a FULL COPY of production data; publishing it under `emse.fr` would expose members' data on a name anyone can reach. Costs no DSI ticket and no third-level certificate |
| Certificates | **issued, deposited and renewed by the DSI** at a fixed path | we never hold a private key and never run a renewal |
| Old domain | `canari-emse.fr` **keeps answering, with 301s, from the old VM** | the less of it on the new installation the better (user) |
| Old VMs | stay powered on for a while after each cutover | they are the rollback |
| Cutover | **a short read-only window**, not zero downtime | the data is under a gigabyte; anything cleverer buys nothing |
| OIDC issuer | several issuers accepted for a while, then **total** migration | a rename cannot be half-done for ever |
| Forced re-login of every member | **acceptable** | the only unavoidable interruption in the chantier |
| Order | **service by service**, least critical first | each service is a rehearsal of the runbook for the next |
| Backups | **reworked in this chantier**, not after | the scheme costs 16x the data, and `restic` is already on the box |
| Rate limiting | nginx, on the authentication and upload paths | replaces the part of Cloudflare that was actually doing something here |
| IPv6 | ask for the AAAA, block on nothing | the narrow case is IPv6-only mobile carriers, and their NAT64 already covers it |
| TURN | **later, and a separate request** | it needs an inbound UDP range, refused more easily than a DNS record - do not attach it to one |

## 5. The target shape, and the one thing it forces

**A single process owns ports 80 and 443, and five estates will want them.** The host's nginx is
therefore the TLS terminator and the vhost router; every project publishes on a distinct loopback
port and never on `0.0.0.0`.

This is not a new idea being imposed - it is already the house style, and Portail-etu is the worked
example: its container publishes `127.0.0.1:3000:3000`, and something on the host terminates TLS in
front of it.

**For Canari this is a SMALL change.** Its in-container nginx keeps everything that makes it
valuable - `Content-Security-Policy`, CORS, the `auth_request` subrequest, the route table, the SSR
fallback - and simply receives plain HTTP from the host's nginx instead of from `cloudflared`. The
contract at that seam is identical, which is why [nginx](nginx.md) needs no rewrite.

```
            :443  host nginx  (TLS, DSI certificates, vhosts, rate limiting)
                      |
      +---------+-----+------+------------+
      |         |            |            |
  127.0.0.1  127.0.0.1   127.0.0.1    127.0.0.1
   :3000      :30xx        :30xx        :30xx
  portail    canari-prod   cercle      authentik
             (its own nginx, then its services)
```

### What the edge did that the origin must now do

| Edge mechanism today | After phase 2 |
| --- | --- |
| TLS termination | host nginx, DSI certificates |
| `www.` -> apex redirect | host nginx |
| Cache Rules on `/_app/immutable/` and the shell | **deleted, not ported.** With no CDN there is no shared cache, so `s-maxage=60` and the purge have no object. `max-age` on the origin keeps meaning what it means |
| The zone purge after a deploy | **deleted**, with `CLOUDFLARE_CACHE_PURGE_TOKEN` |
| Access on admin hostnames | unchanged - those names stay internal, on `rootz-emse.fr` |
| DDoS absorption, bot filtering | nginx rate limiting on the authentication and upload paths, plus whatever the School already runs upstream |
| `min_tls_version`, `0rtt`, BIC, Rocket Loader | nginx configuration, or they stop existing |

### THE CERTIFICATE RENEWAL IS THE TRAP, AND IT IS NOT HYPOTHETICAL

The DSI drops a new file in `/etc/certs/<name>/` - the path is measured, not assumed, since
2026-09-23 - and **nothing will reload nginx**. The site then dies
on expiry day, with no warning and no failing gate anywhere in this repository - the deploy is
green, the containers are up, the health check passes, and the name is simply refused by every
browser.

This is the durable rule about a correct mechanism with no report, in its purest form. Two things
are owed, and neither is optional:

1. a reload triggered by the file being replaced, not by a human noticing;
2. **a report that names the expiry date and accuses BEFORE it**, because a reload that fires
   correctly and a certificate that was never renewed look identical from the inside.

### The cohabitation, and the rename that is only free once

Five compose projects will share one daemon: `portail-etu`, `canari-prod`, `canari-dev`, `cercle`,
`authentik`.

- **Every project declares a `name:`.** A compose file without one is named after its DIRECTORY,
  which is the defect that once put dev one forgotten flag away from mounting production's volumes
  ([dev-environment](dev-environment.md)). Portail-etu's `docker-compose.yml` declares none today.
- **`infrastructure` becomes `canari-prod`, and the migration is the ONLY moment this is free.**
  Renaming a compose project renames its volumes and so orphans its data, which is exactly why
  production's name has been pinned rather than fixed. The migration restores the data into fresh
  volumes anyway. Miss it, and the production estate is called `infrastructure` on a machine
  carrying five of them, for years.
- **A host port allocation table**, and **resource ceilings on every project**. Dev already has
  ceilings; Portail-etu has none, and on a shared box the first project to run away takes the
  others with it.
- **No `docker system prune` without a project filter.** The durable rule is that a destructive
  control needs an allowlist of what it may touch; on a five-estate machine an unfiltered prune is
  a weapon, and the images of four innocent projects are what it reaches.

**`tools/ecosystem-shape/shape.mjs` is where this is asserted.** It already affirms that the four
repositories share one CI shape, across repository boundaries, which is the same job. Extending it
costs nothing and invents nothing; a new tool would be a second mechanism for one question.

## 6. Phase 1 - the move

Order, least critical first, each one a rehearsal for the next:

**`cercle` -> `miconnect` -> `canari-dev` -> `canari-prod`.**

`cercle` is one container with almost no state, so it is where the runbook's mistakes are cheap.
`canari-dev` immediately before `canari-prod` is deliberate: same compose file, same data shape,
same deploy path, run once for real before the estate that matters.

Per service, and the whole of it:

1. install the self-hosted runner for that repository on the target host;
2. stand the project up beside the old one, on its loopback port, **serving nothing**;
3. restore its data into it, and diff the restore against the source;
4. take a read-only window on the old estate, re-sync the delta, point the tunnel ingress at the
   new loopback port;
5. verify from the outside - `/api/version`, the health endpoint, a real sign-in - then release
   read-only;
6. leave the old VM running and untouched.

**Nothing in phase 1 changes a hostname, a certificate or an OIDC issuer.** If step 5 is not
convincing, step 4 is reversed by pointing the ingress back, and the old estate never stopped being
able to serve.

## 7. Phase 2 - the names

`canari-emse.fr` -> `canari.emse.fr`, `cercle.canari-emse.fr` -> `cercle.emse.fr`,
`auth.canari-emse.fr` -> `miconnect.emse.fr`. Dev does not appear: it goes internal.

**Every name costs a DSI ticket - there is no delegated zone and no wildcard**, so they are all
requested at once, together with the two questions the nginx configuration cannot be written
without.

| Ask | Note |
| --- | --- |
| `canari.emse.fr` | **exists already**, pointing at `193.49.175.122` and serving Portail-etu. To be REASSIGNED, not created |
| `cercle.emse.fr` | new. The School reserves `etu.emse.fr` for mail, so it is not `cercle.etu.emse.fr` |
| `miconnect.emse.fr` | new |
| `www.canari.emse.fr` | new, and only so the redirect to the apex exists |
| AAAA for the above | only if the host has a v6 address. Nothing blocks on it |
| The certificate path, and one SAN certificate or one per name | **this is the blocking answer**, not a nicety |
| Confirm 80/443 inbound are already open | the machine already serves `portail-etu.emse.fr`, so this is expected to be a no-op |
| Is the account on the target host also `jolan.boudin`? | the bastion half is proven, the target half is not |

**TURN is deliberately NOT in that request.** It needs an inbound UDP range, which is a different
kind of ask and is refused more easily than a DNS record; attaching it would put the whole list at
risk. It goes in its own request when calls are revived ([calls](../frontend/modules/calls.md)).

### The deep links are the one thing a redirect cannot fix

`applinks:canari-emse.fr` in the iOS entitlements and `android:host="canari-emse.fr"` in the
manifest are **compiled into the binary and shipped through two stores**. A redirect does not reach
them: an installation that is never updated will open the old host for ever.

What makes this survivable is that the repository is already shaped for it. `MOBILE_APP_LINK_HOSTS`
in `frontend/src/lib/mobile/appSiteAssociation.ts` is ONE list, and it feeds both `.well-known`
endpoints - so serving the association files for two hosts at once is a one-line change, not a
design. `PUBLIC_APP_HOSTS` and `DEFAULT_PUBLIC_APP_ORIGIN` in
`frontend/src/lib/utils/publicAppUrl.ts` are the matching pair on the web side, with a
`VITE_FRONTEND_URL` override already in place. The four NestJS services read their CORS origins
from the environment; only their specs name a host.

So the rule for phase 2 is: **both hosts are claimed by the app for several releases, the
configuration migrates totally, and `canari-emse.fr` keeps answering with 301s indefinitely.** The
old domain is not decommissioned at the end of this chantier, and no date is written for it until
the stores say the old builds are gone.

### The OIDC issuer

Renaming Authentik's public host changes the issuer, which every client configuration names and
every live token was minted under. It is the one interruption with no gradual path: sessions do not
survive it, and a forced re-login of every member has been accepted for exactly that reason.
Several issuers are accepted during the transition; the end state is one. The redirect URIs live in
Authentik's database, not in this repository - see [authentik](authentik.md).

## 8. What is owed by the USER

Pointers only. The substance is in
[backlog](../backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks).

- the DNS and certificate request to the DSI, as one message;
- creating the new Cloudflare tunnel on `rootz-emse.fr` - **the project's token cannot do it**:
  measured 2026-09-02, `GET /accounts/{acct}/cfd_tunnel` answers 200 with an EMPTY list and Access
  groups answer 403, so a tunnel is a dashboard gesture ([cloudflare-edge](cloudflare-edge.md));
- **the rights request, and it BLOCKS EVERYTHING**: `jolan.boudin` into the `docker` group, and a
  `sudo` rule narrow enough to be granted - `nginx -t` and `systemctl reload nginx`, nothing more.
  Today the account can read and nothing else. **Accepted by the operator on 2026-09-23**, together
  with deleting the older `boudin` account. **One caveat travels with that deletion**: files owned
  by uid 1008 exist OUTSIDE `/home/boudin`, so a plain `userdel` leaves them owned by a number
  nobody answers to. Enumerate them first (`find / -xdev -uid 1008`) and reassign or remove them in
  the same gesture;
- **the arbitration on capacity**: 4 vCPU and 11 G against three VMs sized for 8 and 20. Either the
  VM grows, or what moves onto it is cut down. Nobody can decide that here;
- one FIDO touch per batched round of investigation on the host. **There is no way to buy more than
  one command with one touch from this workstation** - see the refutation in section 2.

## 9. Open questions

| Question | Who answers | Why it blocks something |
| --- | --- | --- |
| Will the DSI grant `docker` and a narrow `sudo` to `jolan.boudin`? | DSI | **nothing can be done on the host until it is granted** |
| 4 vCPU and 11 G for everything, or does the VM grow? | user, then DSI | it decides whether all three estates move, or only some |
| What are the file NAMES inside `/etc/certs/<name>/`, and who may read the key? | DSI, or one command once `sudo` is granted | the vhost cannot be written without them; the directory is readable, `/etc/ssl/private` is not |
| Is `193.49.175.122` the same machine as `193.49.175.67`? | one DSI answer | the plan asserts it is; port 22 behaves differently on the two |
| What of the shared box's legacy is ours to clean, and what belongs to other associations? | user with the DSI | six php-fpm versions and several dormant sites sit beside us; **none of it is unilaterally ours to remove** |
| Production's Postgres volume size | one command on `canari` | the read-only window is quoted from it |
| Does Portail-etu become a compose project with a declared `name:` and ceilings like the others? | user | it is the only estate that would not, and the standing mandate is homogeneity everywhere |
| What was `zookeeper` for, and why is Authentik's database volume on Canari's VM? | nobody has asked | both are dropped by not being recreated, unless one of them turns out to matter |
| What becomes of the Proxmox host once every VM is off it | user, not yet decided | it is the obvious destination for the reworked backups |
