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

### The three estates, and the capacity question that had an answer

**They are LXC containers, not virtual machines** - `systemd-detect-virt` says `lxc` on all three,
and the tell was `/proc/loadavg` being identical to two decimals and moving together, because load
is not namespaced. `nproc` and `free` do differ, so lxcfs presents the configured limits: the
numbers below are ALLOCATION, and nothing in them is dedicated.

| Estate | vCPU | RAM | Disk | Contents |
| --- | --- | --- | --- | --- |
| `canari` (pve 101) | 6 | 16 G | 125 G, **49 G used** | 23 containers: production AND dev, one daemon, two compose projects |
| `cercle` (pve 102) | 1 | 2 G | 12 G, 6.1 G used | 1 container |
| `miconnect` (pve 103) | 1 | 2 G | 16 G, 5.5 G used | Authentik: server, worker, postgresql |

**Allocated 8 vCPU and 20 G; actually resident, about 2 G in total.** The target offers 4 vCPU and
11 G. The allocation was generous, the consumption is not, and that is what decided the arbitration.
**It is an IDLE reading and not a headroom proof**: it says nothing about a Postgres restore or a
frontend build, and the honest next measurement is the resident set during one.

**THE DATA IS TINY, AND THAT IS WHAT DECIDES THE CUTOVER.** Production media 68 MB, redis 66 MB,
garage meta 5.7 MB, dev's Postgres 216 MB - the whole live state is comfortably under a gigabyte.
A dump, a copy and a restore is therefore MINUTES, which is why no logical replication, no
dual-write and no read replica appears anywhere in this plan. **A short read-only window is the
entire cutover.**

**Of `canari`'s 49 G, roughly 33 G does not move**: MiGallery's 16 G offsite backup living on
Canari's estate, 14.7 G of reclaimable images (86 of them, for 23 containers - no `prune` has ever
run), the runner and its caches, a Rust toolchain on a production box, an uncapped journal, and
orphaned volumes including `zookeeper_logs` and a `miconnect_database` sitting on the wrong estate
entirely. **The move rebuilds from the compose files, so debris is dropped by NOT being recreated.**

### The target host

`portail-etu.emse.fr`, `193.49.175.67`. **WHO reaches it, with which key and from which workstation
is deliberately not written here** - that is an access map for a host this project does not own, in
a PUBLIC repository, so it lives in the operator's local notes.

- **Access is unattended since 2026-09-23.** Connection multiplexing is REFUTED on this workstation
  (the master daemonises, `ssh -O check` says `Master running`, and every client is silently reset),
  so each connection is a fresh ~1.4 s handshake. Batching a survey into one heredoc is a courtesy,
  not a constraint.
- **It is the school's shared association-hosting box, not a Portail-etu server**, and has been for
  years: other associations' sites, MySQL, postfix, NFS mounts and human accounts. **We are moving
  in beside other people.** Which sites and which accounts are deliberately not written here.
- **Debian 13, kernel 6.12, KVM guest**, Docker 26.1.5, and a self-hosted Actions runner for
  `emse-students` already installed - the deploy shape this plan wants existed in part before it.
- **The host nginx is real and terminates TLS**: 80 and 443 on `0.0.0.0`, applications on loopback.
  An earlier reading that TLS terminated in a container was wrong - it tested `command -v nginx`
  against an unprivileged `PATH` and read the absence as an answer.
- **`canari.emse.fr` already resolves, to `193.49.175.122`, AND THAT IS THIS SAME MACHINE**:
  `ip -4 -o addr show ens18` returns `.67`, `.40` and `.122` on one interface. The probe that
  suggested otherwise - `.67:22` answering while `.122:22` is dropped - was a per-address firewall
  rule. The certificate convention is `/etc/certs/<name>/`, one directory per name, not a shared
  SAN, and `/etc/certs/canari.emse.fr/` plus `sites-enabled/canari.conf` were both created
  2026-09-22: **the DSI started preparing phase 2 while this plan was being written.**
- **AND THAT PREPARED VHOST ALREADY ANSWERS - WITH THE NEIGHBOUR'S SITE.** It proxies to
  `127.0.0.1:3000`, Portail-etu's port, so `Host: canari.emse.fr` returns the Portail-etu page.
  Nothing is broken today because no record sends traffic there, **but the day phase 2 creates one,
  Canari's production name serves Portail-etu until that single line changes.**

| | Target host | The three estates to absorb |
| --- | --- | --- |
| vCPU | **4** (QEMU, AVX2 present) | 8 |
| RAM | **11 G** | 20 G allocated, ~2 G resident |
| Disk | **50 G, fully partitioned, no LVM** | 49 G, of which ~33 G is debris that does not move |

**The disk cannot be grown from here** - no LVM, so enlarging it is a DSI action on the VM. The
account is in `docker` and carries `ALL=(ALL) NOPASSWD:ALL`, broader than this plan asked for, so
the restraint is the operator's rather than the system's.

**THE HOST'S STANDING TRAPS ARE IN [durable-rules](../durable-rules.md#the-shared-host-and-what-it-does-to-every-operation---estate-migration), not here**, because they bind every
command run there and not only this migration: a bulk file operation killed half-way with no
diagnostic, two storage classes behind one capacity figure, recycled uids that make `find -user`
worthless, and the ban-on-scan rule whose blast radius is production's own address.

**The bastion keeps office hours and that is the whole of it**: `bastiono-ssh.emse.fr`, 07:00-20:00,
French sources only, stated by the DSI. Two readings died before that sentence - a fail2ban ban
(refuted: a ban cannot silence an address that never tried) and the host being down (right symptom,
wrong cause). **The measurement that carried it was the cheapest one: the SAME address answered in
the morning and was refused at night.** A probe from a new source adds nothing when the variable
that moved was the clock. Outside those hours, `portail-etu-direct` via `ProxyJump canari`, which
works only because `canari` is inside EMSE.

### The host was emptied before the move - 2026-09-24, and it is DONE

It carries **787 packages where it carried 1813**: nine concurrent PHP versions (175 packages, of
which nginx referenced exactly one), apache2, phpMyAdmin, MySQL and its eleven legacy databases,
111 `rc` residues, whole desktop trees, and the `packages.sury.org` repository that outlived them.
`/` went from 16 G used to 12 G, and `/etc` is under version control again - **and that repository
is not etckeeper**, it is one the DSI's own staff drove by hand, fifteen commits, the last in 2019,
so the new commits follow that convention rather than introducing a daemon onto someone else's
machine.

**MySQL is the one that needed evidence before it could go**, and the evidence was its own
histogram: 917 transactions in June 2026, 1 in July, 58 in August, 1 in September. The pre-Canari
bar system stopped in June and what followed was a tail; the user confirmed `ssh cercle` replaced
it. The dump is verified in four places. **What would have talked to a MySQL that is gone was
deleted in the same breath** - two backup crons and a Zabbix userparameter - because a daily cron
failing into a mailbox is the noise nobody reads, and a disabled thing is a thing a later reader
has to re-decide.

**Every check after each batch was on the STATE, never on the exit status**, for the reason the
durable rule above gives. Twelve services and four vhosts were re-verified after each step;
Portail-etu answered `200` throughout.

**ONE THING WAS LEFT IN PLACE DELIBERATELY.** `/opt/actions-runner/runners/portail-etu/_work/refonte-gala/`
looks exactly like 160 MB of reclaimable build debris and every filesystem question said "delete".
The question the filesystem cannot answer is whether the code exists anywhere else:
`emse-students/refonte-gala` answers `404`, and the repository that looks like its successor does
not contain this checkout's `HEAD`. **It is the only surviving artefact of a repository nobody can
clone**, so reclaiming it is a question for its owners
([backlog](../backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks)).

### AIDE reported nothing for two and a half years, and three defects stood between it and a report

The baseline had never been promoted, the daily unit sat in `failed`, and fixing that was not
enough. **The exclusion syntax was wrong twice**: AIDE's `!<regex>` is RECURSIVE-negative - children
of matching directories are still walked and merely not added - so `!/export` excluded the filer
from the database while still walking every `.snapshot` tree it recreates daily. `-<regex>`, added
in 0.19, is the one that prunes, and **`--path-check` settles which rule wins for a path in one
second against twelve minutes for a rebuild**. Pruned: the NFS pseudo-filesystem, the container
network namespaces whose ids are random per start, `/export`, and the 51007 entries under
`/var/lib/docker` that every build rewrites. `/etc`, `/usr/bin` and `/etc/shadow` stay watched.

**And the report reached nobody.** Debian runs AIDE as `_aide` with `CAP_DAC_READ_SEARCH`, which
disables the suid bit the traditional `sendmail` interface needs, and `s-nail` was absent - while
`/etc/aliases` sent root's mail to an address that no longer exists. **Half of every alert this
machine has raised went into the void.** The alias now names a live mailbox and delivery was proven
end to end. This is the durable rule about a correct mechanism with no report, met three times in
one afternoon, and none of the three would have shown up in a green check.

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

## 4. The decisions - taken with the user 2026-09-23 and 2026-09-24, NOT TO BE RELITIGATED

| Decision | Value | Why |
| --- | --- | --- |
| Shape on the new host | **Docker compose projects side by side**, not nested virtualisation | simpler, and it is the shape every future project gets |
| Public traffic | **No Cloudflare at all** - nginx, ufw and DSI certificates | the School owns the zone and will not delegate it |
| Internal traffic | stays on **`rootz-emse.fr`** behind a Cloudflare tunnel, with Access | an admin interface does not need a public name, and a gated door does not need a signpost |
| **Where dev and the admin surface run** (2026-09-24, REVISED the same day) | **BOTH Canari estates move to the target, dev included** - reached the same way as production, through the old VM's relay, never a new connector | the earlier "stays on the old VM" reading argued from the refused port, but the relay already answers that regardless of which estate sits behind it; keeping dev off the target bought nothing further and cost it rehearsing production less faithfully |
| The tunnel | **stays where it already works**, on the old VM (2026-09-24) | nothing is installed on the new host for it, so nothing there needs to reach the edge |
| Dev | **`dev.canari-emse.fr`**, a proxied CNAME on production's OWN zone and tunnel (not `rootz-emse.fr`, and not behind Access) - **now hosted on the TARGET, reached via the old VM's relay** (revised 2026-09-24) | it was never internal: dev holds a FULL COPY of production data and answers `200` to anyone who resolves the name, unlinked but not gated. Only WHERE it runs changed, not its exposure |
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
| Le Cercle's compose project name | **stays `le-cercle`** | declared in the file, matches the repository and the GitLab project - it was never inferred, so it was never actually at risk |
| `miconnect`'s compose project name | **now declared explicitly**, kept `miconnect` | it had none at all and took its name from the directory by luck; the product's own name beats the software's (`authentik`), since the SSH alias and `/srv` path already say `miconnect` |
| Canari's compose project name | `infrastructure` -> **`canari-prod`**, at the move, in the same commit that moves its path (section 10) | it is a DECLARED name, but the wrong one, and renaming it any earlier brings the CURRENT box up on empty volumes at the next ordinary deploy |
| Le Cercle's database | stays SQLite; **moves to PostgreSQL AFTER the migration**, as its own chantier | homogeneity, not containment - the SQLite file already lives in a named volume exactly as Canari's Postgres data does; the rewrite touches ~68 files and a 234 366-row ledger, not worth doing during a migration whose remaining steps are minutes |

**The `miconnect` row exists because of a defect that was silent by design.** A compose project with
no declared `name:` takes its directory's, and a differently-named one starts on an EMPTY database
instead of failing - the one place the OIDC configuration lives. It survived the move only because
the old and new paths both happened to end in `miconnect`. `docker compose up -d --dry-run` after
the fix answered `Running`/`Healthy` with no recreation - the declaration is a no-op for Docker,
which is the whole point of catching it before it was not one.

### The 2026-09-24 decision, and why it deletes a chantier instead of solving it

**REVISED THE SAME DAY: the new host carries BOTH Canari estates, not production alone.** The
paragraph below was written when dev was meant to stay behind; the user reversed that once the
relay proved dev moves through the IDENTICAL mechanism as production, not a new one, so keeping it
off the target bought nothing. What the original reasoning still settles, unchanged by the reversal:
no connector is installed on the new host for EITHER estate, so the refused port never mattered to
begin with, whichever estate sits behind the relay.

| What it settles | |
| --- | --- |
| Outbound 7844 on the new host | **no longer a blocker, and not worth a DSI request** |
| The connector installed there on 2026-09-24 | **REMOVED** the same day - unit, `EnvironmentFile`, binary, apt source and keyring; the host is back to its prior state, and the run token no longer sits on a machine shared with other associations |
| The relay from the old VM | **NEEDED, for phase 1's PUBLIC path AND for dev** - every public name and dev's internal one reach their estate through the SAME relay, on a machine we already administer. See the relay section |

**AND IT DOES NOT MAKE PHASE 1 TUNNEL-FREE.** Phase 1 preserves the OLD public names, which reach
the edge through the tunnel; only the CONNECTOR's location was settled here. The relay section below
is what carries that.

**RESOLVED, the same way: Authentik's admin interface.** It is a PATH inside Authentik, not a
separate service, so it could never have stayed behind while the rest of `miconnect` moved - and
`miconnect` moved in full on 2026-09-24, admin path included. Nothing further to decide here.

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

**THE `30xx` ABOVE ARE NOW CHOOSABLE, BECAUSE THE HOST'S LOOPBACK HAS BEEN ENUMERATED** (2026-09-24).
This is the table section 8 owed BEFORE the DNS request, since the prepared `canari.conf` already
proxies to `127.0.0.1:3000` - which is Portail-etu's.

| Port | Held by |
| --- | --- |
| 22 | `sshd` |
| 80, 443 | host nginx |
| 111 | `rpcbind` |
| **3000** | **the Portail-etu container - what `canari.conf` currently points at** |
| 6060, 7422, 8080 | a host-owned agent this project does not administer |
| 10050 | Zabbix agent |
| 44855 | containerd |

Nothing else listens, and the `30xx` guess above was one: `cercle` took **`5173`** on 2026-09-24,
not `3002`, because `CERCLE_PUBLISH` already named it on the old VM and changing the publish address
and the machine in the same gesture would have made a failure unattributable. **The rule is a
distinct loopback port, not a consecutive one.**

#### WHICH CONTAINER PUBLISHES WHAT - MEASURED ON THE FOUR MACHINES, 2026-09-24

Built after the `cercle` cutover, because the loopback table above answers "what is taken" and not
"what is asked for", and the difference decides whether an estate fits. Internal ports are shown
only where a container publishes; an `EXPOSE`d port reached over the compose network is not a
migration constraint and is left out.

| Estate | Container | Publishes today | -> container | Target loopback |
| --- | --- | --- | --- | --- |
| Portail-etu | `portail-etu` | `127.0.0.1:3000` | `3000` | **already there** |
| `cercle` | `cercle` | `0.0.0.0:5173` on the old VM | `3000` | **`5173`, LIVE since 2026-09-24** |
| `canari` prod | `infrastructure-frontend-1` | `0.0.0.0:8080` | `80` | **NOT `8080` - see below** |
| `canari` prod | `infrastructure-garage-1` | `127.0.0.1:19010`, `:19011` | `3900`, `3903` | free, but see the question below |
| `canari` prod | `infrastructure-adminer-1` | `127.0.0.1:8888` | `8080` | **does not move** - admin surface, decision 4 |
| `miconnect` | `miconnect-server-1` | `0.0.0.0:9000`, `:9443` | `9000`, `9443` | `9000` free; `9443` has no object - see below |
| `canari` dev | `canari-dev-*` | `127.0.0.1:3080`, `:19100`, `:19101` | - | **does not move** - decision 4 |

**THE CANARI PRODUCTION STACK ASKS FOR ONE PORT ON THE PUBLIC PATH.** Twelve containers run on
`canari` and only THREE publish at all - the frontend, adminer and garage, each a row above. The
other NINE publish nothing: `frontend-ssr`, `chat-gateway`, `call-service`, `chat-delivery-service`,
`media-service`, `core-service`, `social-service`, `postgres` and `redis` are reached by service name
over the compose network and cross no host boundary. So the public surface is `infrastructure-frontend-1`
alone - the in-container nginx section 5 opens on - and the shape above needs no rewrite. **The other
two publishers are not public and are not thereby free**: they are the admin-surface question decision
4 already governs, answered for adminer and open for garage.

**`8080` IS REFUSED, AND IT IS THE ONE PORT CANARI CURRENTLY USES.** It is held on the target by a
host-owned agent this project does not administer, so the collision is not negotiable from our side:
the frontend's publish address changes. It has to change anyway - `0.0.0.0:8080` breaks the house
rule in the same line, and on the target a `0.0.0.0` bind is *also* the thing the firewall
measurement said would be unreachable rather than exposed.

**`9443` ON `miconnect` HAS NO OBJECT BEHIND A TLS-TERMINATING NGINX.** Authentik publishes both a
plain and a TLS listener; the host's nginx terminates TLS with the DSI certificate and speaks plain
HTTP to the loopback, exactly as it does for the other three. Carrying `9443` across would mean
either a second certificate on the box or `proxy_ssl_verify off`, and both are refused elsewhere in
this plan. **This is the same seam as [authentik](authentik.md)'s, and it is not yet decided.**

**OPEN: does garage's published pair move, and who consumes it?** The two ports are loopback-bound on
`canari` today, so nothing outside that machine reaches them - but "loopback-bound" says where they
may be reached from, never who reaches them. Garage is production object storage and moves with
production; `19011` is its admin port and would be an admin surface under decision 4. **Enumerate the
consumers before choosing**, which is what the standing rule about auditing a seam requires.

### What the edge did that the origin must now do

**Re-audited against the live zone and the live host, 2026-09-25** - every deliberate Cloudflare
setting is in [cloudflare-edge.md](cloudflare-edge.md#settings-that-are-deliberate); this table is
what each one becomes once `canari.emse.fr` never reaches that zone at all. A claim below is
VERIFIED only where it was actually probed, not inferred from the intent that shipped it.

| Edge mechanism today | After phase 2 | Verified 2026-09-25 |
| --- | --- | --- |
| TLS termination, `min_tls_version: 1.2` | host nginx, DSI certificates | **YES** - `--tlsv1.0 --tls-max 1.0` refused (connection failure), 1.2 and 1.3 both `200` |
| `www.` -> apex redirect | N/A - no `www.canari.emse.fr` DNS record exists at all (the row was dropped from the DSI request, item 1) | **YES** - `www.canari.emse.fr` does not resolve/connect; nothing to redirect |
| CSP header | N/A - was never a Cloudflare setting. `http_response_headers_transform` on the zone is empty by design; nginx has always owned every response header, unaffected by which hostname is used | N/A |
| CSRF protection | N/A - Cloudflare has no CSRF-specific feature; this was always application-level (SvelteKit/NestJS origin checks), unaffected by the zone | N/A |
| `websockets: on` (zone setting, "Required by `/api/ws`") | **WAS NOT PORTED - FOUND AND FIXED 2026-09-25.** `sites-available/canari.conf` on the target host proxied `/` but never forwarded `Upgrade`/`Connection`, unlike `canari-prod.conf` and `canari-dev.conf` (written earlier, in phase 1, and correct). A WS handshake against `canari.emse.fr` got a bare nginx `400` with no `Upgrade` echoed back; the same handshake against `canari-emse.fr` reached the app and got `401` (unauthenticated, the correct answer). Fixed by adding the same two lines `canari-prod.conf` already carries | **YES, both before (broken) and after (fixed)** |
| Cache Rules on `/_app/immutable/` and the shell | **deleted, not ported.** With no CDN there is no shared cache, so `s-maxage=60` and the purge have no object. `max-age` on the origin keeps meaning what it means | N/A - deliberate |
| The zone purge after a deploy | **deleted**, with `CLOUDFLARE_CACHE_PURGE_TOKEN` | N/A - deliberate |
| Access on admin hostnames | unchanged - those names stay internal, on `rootz-emse.fr` | N/A - out of scope |
| DDoS absorption, bot filtering | promised as "nginx rate limiting on the authentication and upload paths" | **NO - NOT DONE.** `grep -r limit_req /etc/nginx` on the target host returns nothing, on any vhost. This is a real gap, open below |
| `0rtt`, BIC, Rocket Loader | Rocket Loader and BIC have no nginx equivalent and were already `off`/scoped to the auth subdomain (out of scope); 0-RTT is a TLS 1.3 server option nginx does not enable by default, matching the zone's `off` | N/A - all three end up equivalent to "off" either way |

**OPEN: no rate limiting exists on the authentication or upload paths on the target host, on any
vhost.** This was stated as done in this table before being checked and was not; it needs a design
(zones, keyed by IP, which exact paths) rather than a one-line port, and is tracked as its own item
rather than folded into the WebSocket fix above ([backlog](backlog.md)).

### THE CERTIFICATE RENEWAL IS THE TRAP, AND IT IS NOT HYPOTHETICAL

The DSI drops a new file in `/etc/certs/<name>/` - the path is measured, not assumed, since
2026-09-23 - and **something does reload nginx**: `/etc/cron.d/reload-nginx` runs
`systemctl reload nginx` at 01:00 daily, with a comment saying it exists for exactly this reason.
**Half of this trap was already closed by the DSI, and the claim that nothing would reload was
wrong.**

**The other half is untouched, and it is the dangerous half.** That reload is blind: it fires
whether or not a new file arrived, and it reports nothing either way. A reload firing correctly over
a certificate that was never renewed is indistinguishable from a working system - until expiry day,
when the site dies with no warning and no failing gate anywhere in this repository. The deploy is
green, the containers are up, the health check passes, and the name is simply refused by every
browser.

This is the durable rule about a correct mechanism with no report, in its purest form. One thing is
owed:

1. **a report that names the expiry date and accuses BEFORE it.** The daily reload already covers
   delivery; **nothing covers non-delivery**, which is the failure that actually takes the site
   down.

#### ONE CERTIFICATE PER NAME, AND IT IS NOT ACME - MEASURED ON THE TWO LIVE NAMES, 2026-09-24

The certificate question in section 7 was listed as **the blocking answer** the nginx configuration
could not be written without. It is answered, and by reading the two certificates the School already
serves rather than by asking:

| | `portail-etu.emse.fr` | `canari.emse.fr` |
| --- | --- | --- |
| Subject CN | the name itself | the name itself |
| `subjectAltName` | **`DNS:portail-etu.emse.fr` and nothing else** | **`DNS:canari.emse.fr` and nothing else** |
| Issuer | GEANT TLS RSA 1 (Hellenic Academic and Research Institutions CA) | the same |
| Validity | 2026-07-23 -> 2027-02-07 | 2026-09-22 -> 2027-04-09 |

**One certificate per name.** Four names is four certificates, four expiry dates and four renewals -
not one SAN bundle, so the nginx configuration gets four `ssl_certificate` pairs and the report this
section owes has four dates to watch, not one.

**And it is the GEANT TCS service, on a ~6.5-month validity - there is no ACME anywhere in this.**
Nothing in this repository, and nothing on the host, can renew one: a renewal is a DSI action
followed by a file landing in `/etc/certs/<name>/`. That is precisely why the blind 01:00 reload
covers delivery and nothing covers NON-delivery, and it is why the missing report is the whole of
what is owed here.

**`canari.emse.fr` IS LIVE, AND ITS CERTIFICATE WAS REISSUED TWO DAYS AGO** (2026-09-22). It serves
`Portail Etudiant ICM` - a SvelteKit application, `nginx`, HTTPS only, port 80 does not answer - from
**`193.49.175.122`, which is NOT the host `portail-etu.emse.fr` runs on** (`193.49.175.67`). So the
line in section 7 calling it a reassignment is right, and thinner than the thing it describes: the
ask is to take a name off a running site on a machine this project has never inventoried, whose
certificate somebody renewed this week. It is the one item in that request that can be refused on
its merits, and the request should say what it is rather than let it read as moving a spare record.

**The three other names do not exist at all** - `cercle.emse.fr`, `miconnect.emse.fr` and
`www.canari.emse.fr` all answer `NXDOMAIN`, and neither live name carries an `AAAA`. There is no
wildcard: a nonsense name under `emse.fr` answers `NXDOMAIN` too, which is worth stating because the
first measurement here appeared to show one - the resolver's own address, echoed by `nslookup` in
every answer, read as a record.

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

1. install the self-hosted runner for that repository on the target host - **and `cercle` is not
   a GitHub repository at all.** It lives on `gitlab.emse.fr`, so its runner is a `gitlab-runner`
   registered against that project, not an Actions runner; the two coexist on the host and neither
   knows about the other;
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

### The network shape, settled 2026-09-24 - only 22, 80 and 443 enter the target, from anywhere

**Measured, with a control**: a container publishing a high port on the host's public address was
reachable from the host itself (the control) but timed out from the workstation and from BOTH old
estates over the private range, while 22/80/443 answered from an old estate every time. `DOCKER-USER`
is a bare `RETURN` and the `DOCKER` chain ACCEPTs directly - the textbook shape of Docker punching
through a host firewall, so the filter is the school's network border, not the host's own rules, and
it is symmetric with the finding below. **This settles the architecture**: there is nothing to bind
and restrict, because nothing but those three ports arrives at all, so every service stays on
loopback with the host's own nginx routing by `Host` - which is what section 5 already chose, now
validated by a firewall rather than by an argument.

**A tunnel cannot be created from the workstation** (`10000 Authentication error`, and the tunnel
list answers `success` with zero tunnels while production plainly runs one - a shape that would
mislead a caller who trusts it). The user made the dashboard gesture, and the resulting connector
could not reach the edge either: **TCP 7844 is blocked outbound from the target, in both the UDP and
the `http2` fallback transports, to two different edge addresses**, while the same probe from `canari`
succeeds on the same command. The block is upstream of the machine and there is no port-443 fallback
for Cloudflare Tunnel, so this would have needed a firewall change or nothing.

**The user took the other option instead** (section 4): no connector is installed on the new host
for ANY estate, so a machine that needs no tunnel does not care what its network refuses - which
holds whether one estate sits behind the old VM's relay or several. A **proxied Cloudflare `A`
record** to the target's own address was drafted as an alternative to a tunnel and is REFUTED by
that same section-4 decision (no Cloudflare in the public path) - kept nowhere else because the only
thing worth keeping from it is the reasoning trap it shows: a seam solved through the one consumer
just discussed, not through all of them.

**The relay that phase 1 actually needs already runs in production.** `cercle.canari-emse.fr` is
served today by a connector on the OLD VM proxying across the private network to the target with SNI
`canari.emse.fr` and `Host: cercle.canari-emse.fr` - the target's nginx routes on that `Host` alone.
Nothing new was built for this: the tunnel keeps pointing where it points today, the old VM's nginx
gains one upstream, and rollback is one line on a machine we own. The alternative - editing the
tunnel's own ingress - is not ours to take: production's connector is remotely managed, its ingress
lives in Cloudflare, not on the box. **The source address the target sees is the old VM's PRIVATE
address, preserved end to end with no NAT rewrite**, which is what lets a future allow-rule pin to
one address rather than opening a port to the internet; the exact addresses stay in agent memory,
not in this public repository.

**The target's `cloudflared` was REMOVED entirely, not merely disabled**, once the section-4 decision
made a connector on that box pointless: a run token in a file is a liability a disabled unit keeps
alive, and the only thing worth keeping is the four lines of configuration recorded here. **Two
tunnel identities are in play** - the box carried one and a second was handed over the same morning -
and neither was overwritten, because picking the keeper is a dashboard-side decision; guessing wrong
leaves an orphan tunnel claiming a hostname later.

**The Portail-etu runner move is the template for the other two.** It ran as one person's login from
that person's home; it now runs as `gha-runner`, no password, no `sudo`, one group, one install
directory per repository under `/opt/actions-runner/runners/<repository>/`. The one line that had
encoded three host facts (`~/actions-runner/_work/refonte-portail-etu/...`) now reads
`$GITHUB_WORKSPACE` ([PR 83](https://github.com/emse-students/refonte-portail-etu/pull/83)), proven
by dispatching the runner's other job after the move. **A runner directory's numbered `bin.2.336.0`
and `bin.2.337.0` siblings are not update leftovers** - `bin` and `externals` are symlinks into the
newest one, which is how a self-update swaps versions atomically; deleting the "leftovers" broke
`svc.sh` with no hint of the cause and was repaired by re-extracting the matching release archive.
The rules this needed already exist (a destructive control needs an allowlist, not a pattern that
looks like debris; a name is not evidence, `ls -l` before `rm -rf`) - the sharpening is that the
symlinks pointed at ABSOLUTE paths under the old home, so the move alone would have broken them and
the deletion only changed a silent break into a loud one.

### `cercle` HAS MOVED - 2026-09-24, AND IT IS THE SHAPE THE OTHER TWO FOLLOW

| Ready | What was done |
| --- | --- |
| The runner | `cercle-portail`, shell, locked to the project, **registered PAUSED** so no job lands on it by accident, `gitlab-runner` **19.3.2 - the exact version of `gitlab.emse.fr`** (the repo offers 19.4.0, deliberately left off that host's unattended-upgrades origins) |
| `/srv/le-cercle` | pre-created, owned by `gitlab-runner` - the deploy job's `mkdir -p` runs as that account and `/srv` belongs to root |
| The two variables | `CERCLE_RUNNER_TAG` and `CERCLE_PUBLISH`, already through one production deploy |
| The data | restored into `le-cercle_cercle-data`, owned by uid 1000 as the image expects |

**The data rehearsal is a diff, not a copy**: `VACUUM INTO` while serving (never a `cp` of a live
SQLite file), moved through the workstation because the two boxes cannot reach each other, then
inventoried on both sides by the same script - **17 tables, 455722 rows, `user_version = 2`,
`integrity_check = ok`, identical**, with the transferred archive's md5 matched at both ends. A count
alone would not have settled it - it answers "how many", never "which".

**The cutover is four gestures, and they are the model for `canari-dev`/`canari-prod`:**

1. **The tunnel/relay** - repoint or extend the existing relay; this is the user's dashboard gesture
   and the only blocking one.
2. **The read-only window** - stop the old container, re-run `VACUUM INTO`, move the file, restore
   it into the target volume, diff it again.
3. **The flip** - pause the old runner, un-pause the target one, set the tag and the publish address,
   re-run the pipeline on `main`. It builds on the new host, writes `.env` from the same CI
   variables, migrates and starts.
4. **The verification** - the health endpoint through the public name, and a real sign-in. `ORIGIN`
   does not change in phase 1 and `sessions` travels with the database, so nobody is signed out.

The rollback is gestures 3 and 1 reversed, and it costs nothing because the old VM never stopped
being able to serve - its container and data are left in place, which is why the two host-specific
values are variables rather than lines in a commit. **Two hand-made snapshots inside the live volume
were dropped** (`pre-formation-rename.db`, `pre-reclass.db`, archived on the workstation first, the
renames they precede a month live) - the move copies the live database only.

**IT IS DONE.** Pipeline `#22369` built and deployed on the new host; the public name moved the same
morning. The full chain: the Cloudflare tunnel reaches the old VM exactly as before, an nginx relay
there proxies to the target with the SNI/`Host` pair above, the target's vhost routes to the
container. `200` from outside in 0.13-0.19 s against 0.16 s before - the extra hop costs nothing
readable - and the **target's own access log**, not just the response, names the old VM as the
client, which is what proves the new machine answered rather than merely responded. The old
container is `Exited (0)` under `unless-stopped`, which honours the manual stop across a daemon
restart and cannot come back to contend for the port.

**The read-only window was not needed, and a clock was not what proved it.** A per-table content
fingerprint - rows serialized, SORTED, then hashed, so it survives the reordering a `VACUUM`
performs and answers about CONTENT rather than "how long since a write" - matched on **all 17
tables**, `ledger`'s 234 366 rows included.

**Two traps found here are now durable rules**: a restored database read and could not be written
because the copy carried the FILE's permissive mode and not its DIRECTORY's, which WAL mode's
sibling files need ([durable-rules](../durable-rules.md#the-shared-host-and-what-it-does-to-every-operation---estate-migration));
and the health endpoint's `ok` read masked exactly this for nine hours because `BEGIN IMMEDIATE`
defers its write and is not a write probe, which the journal-mode table below settles.

| Probe | WAL | `DELETE` |
| --- | --- | --- |
| a plain `SELECT` | refused (`SQLITE_READONLY_DIRECTORY`) | passes |
| `BEGIN IMMEDIATE` then `ROLLBACK` | refused | **passes** |
| a real `INSERT` (the control) | refused | refused |

In WAL mode nothing works at all, because opening the database means creating `-shm`; in `DELETE`
mode a read succeeds and only a write fails, so the SAME endpoint would have reported `ok` on a
database nobody can write. **A column is only evidence for the question it was written to answer**
([durable-rules](../durable-rules.md)): this one asks whether the schema can be READ, and answered a
second question only because the journal mode made the two coincide.

### `miconnect` - MOVED 2026-09-24, BY HAND, BECAUSE NOTHING DEPLOYS IT

**No pipeline has ever built this estate** - `infrastructure/authentik/README.md` described a
`deploy.yml` copying its compose file that does not exist, and the repository's compose file was a
REBUILD REFERENCE that had drifted, including a pinned `2026.2.2` against a running `2026.8.0` (a
schema downgrade Authentik's migrations cannot undo). Both are corrected. **The stack is one volume
and two ports**: `9443` was not moved, it was DELETED - the tunnel has only ever reached Authentik in
plain HTTP on `9000`, and nothing asked for the TLS port. `data/`, `certs/` and `custom-templates/`
total 24 K; nothing travels but the database.

**The nightly backup's SSH hop was believed and was not real** - the repair existed only in the
repository (production was still on an older tag, no such key existed on the box, and the archive
written that morning had no Authentik among its members); the streak was 94 nights, not 93, and it
ended by hand. The opposite instruction - empty the variable, because the two stacks now share a
host - was also wrong: they do not meet yet, Authentik left and Canari stayed, so the hop is MORE
necessary, simply reversed to point at the target. It becomes correct only the day Canari itself
arrives.

**Stood up on the target, empty, then taken down first**, to answer what a plan cannot: 907 MB
across all three containers on a 2 G VM, under two minutes to healthy including migrations, refused
from the outside and healthy on loopback. The loopback binding needs no compose edit - the `.env`
interpolates an address rather than a bare port. **uid 1000 collided with the host's own automation
account** ([durable-rules](../durable-rules.md#the-shared-host-and-what-it-does-to-every-operation---estate-migration))
and was benign only by luck; the three bind-mounted directories are candidates for named volumes at
the cutover.

**IT IS DONE.** The window was 6 min 37 s, almost all of it one `pg_dump` crossing two SSH hops.
`https://auth.canari-emse.fr` answers `200` in 0.24-0.40 s from outside, the target's own access log
names the relay as the client, and **every one of 230 tables' content fingerprints matched, zero
errors or warnings in either service's log**. The relay here is a `nginx:alpine` CONTAINER rather
than a package - the VM has no usable nginx and no `sudo`, `docker` needs none - listening in clear
and raising TLS itself; **interposing it imposed a body-size ceiling that never existed on the direct
path** (`client_max_body_size 50m`, set on both halves), which is the general lesson: a proxy
inherits none of the defaults of the thing it replaces.

**The end-to-end proof went past the login page**, because a `200` there proves almost nothing:
OIDC discovery and JWKS answered for all five applications, `/application/o/authorize/` reached the
flow executor, and the CAS EMSE redirect still lands on `auth.canari-emse.fr` as its callback - the
one row that could have silently broken, since CAS validates a callback URI registered on ITS side
and the move changed the machine without changing the name. **Phase 2 is where that row becomes a
request to another team, not a check.** The rollback stays armed: only `server`/`worker` were
stopped, `unless-stopped` will not restart them on its own, and reversing is `docker compose start
server worker` once the relay is down.

**A first differential run agreed with itself and was wrong** - it reported "IDENTICAL, 3 tables" for
a 230-table database because the query read `relname` where `pg_tables` exposes `tablename`, so both
sides returned the same `ERROR` and `diff` was right to call them equal. This is the durable rule
about a comparison proving equality of whatever it actually read
([durable-rules](../durable-rules.md#contracts-the-compiler-does-not-check)); the corrected run read
230 tables with zero `ERROR` lines before its verdict was believed.

### `canari` - MOVED 2026-09-24: it was two estates and a CI runner, not one estate

Measured on the `canari` box, 2026-09-24:

| What | RAM | Disk | Note |
| --- | --- | --- | --- |
| `infrastructure` (production, 12 containers) | 575 MiB | 307 MB of volumes | -> `canari-prod` at the move |
| `canari-dev` (11 containers) | 1384 MiB | 217 MB of volumes | `dev.canari-emse.fr`, same box |
| GitHub Actions runner | - | 5.5 GB (3.9 GB of `_work`) | `runs-on: self-hosted` |
| The two checkouts, local backups, images | - | ~2 GB, 593 MB, 10.5 GB (5.5 GB reclaimable) | |

The target has 8.9 GB of RAM and 27 GB of disk free against roughly 2 GB and 13 GB needed - it fits,
and stays comfortable only if the target's own 2 GB of build cache and 1.3 GB of reclaimable images
are pruned first. **Both estates move** (user, 2026-09-24): dropping dev would break release gate 2,
which refuses a stable unless a pre-release served dev at that commit.

**Moving them does not switch the old VM off.** Its connector's ingress carries nine names; three
(`pm`, `wiki`, `archives`) are no part of this migration and two more (`cercle`, `auth`) now point at
relays. The box survives phase 1 as the estate's single connector regardless of what Canari does -
only the tunnel moving or disappearing, phase 2's subject, changes that.

**The runner moves with the estates; the deploy does not convert to SSH.** A GitHub-hosted runner
cannot reach the target at all: `193.49.175.67:22` timed out from this workstation's address and
answered from `mitv` and from the `canari` box, both on `193.49.174.63`. It is not an IP ban - `443`
connects from the SAME workstation address that `22` refuses, and a ban would take both - so the
filter is per-port and upstream of the machine (`sshd` on `0.0.0.0:22`, empty `hosts.deny`, no local
firewall at all). SSH into that host is a campus-network privilege, which is the entire reason the
DSI runs a bastion, and it is why Portail-etu already deploys from a runner installed ON the target
rather than over SSH.

Canari's runner takes the same shape, in its own group:

| | |
| --- | --- |
| Shape | ORG-level, name `canari`, group `canari`, `visibility=selected` to this repository alone, `allows_public_repositories=true` (the same posture Portail-etu already carries, for the same reason: the repo is public) |
| Account | `gha-runner` - no password, no `sudo`, member of `docker`, home `0700` - so `deploy-environment.sh` and `verify-secrets.sh` both resolve plain `docker` on their first branch |
| Install root | `/opt/actions-runner/runners/canari/`, beside `cercle` and `miconnect` |
| Isolation | the GROUP, not the label - every runner answers to the bare `self-hosted` that four jobs (`serve-prod`, `serve-dev`, `hosts`, `dev-refresh`) ask for, and `visibility=selected` is what keeps a Canari job off the Portail-etu runner and the reverse |

**None of those four jobs changes** - `deploy-env.test.sh` derives its assertions from that literal
string and keeps deriving them. The machine underneath moves; the mechanism does not. **The only
variable left is the address**, which is why the move is one step rather than the two a transport
change would have needed.

**The publish addresses were chosen by measurement, not by convention.** Listening on the target,
2026-09-24: `3000` (`portail-etu`), `5173` (`cercle`), `9000` (Authentik), `6060`/`7422`/`8080` held
by the host's own DSI-managed agent - not ours to move. `canari-prod`'s frontend takes
**`127.0.0.1:8081`**, adjacent to the `8080` it uses today so the one-line difference stays legible;
dev keeps its current `3080`/`19100`/`19101`. **Production's `0.0.0.0:8080` must not survive the
move**: Docker publishes through the nat table, which firewalld's zone does not govern, so a port
published on `0.0.0.0` there is reachable from the whole campus network whatever the zone says - the
same finding Le Cercle's own compose file already carries a paragraph about.

**IT IS DONE, in full, for both estates - data, traffic, the runner and the crontab (step 10.6).**
The target's org-level `canari` runner is `online` (`gh api orgs/emse-students/actions/runners`);
the old box's repo-level `Canari` runner is `offline`, stopped and disabled via the docker-chroot
route (no sudo password on that account). The old box's crontab is gone entirely (`crontab -r`,
backed up first to `/home/canari/backups/crontab.removed-2026-09-24.bak`) - the three lines it
carried (nightly backup, object backup, egress probe) already run from the target under
`gha-runner`, which now also schedules Le Cercle's own backup at 04:15
([le-cercle deployment](https://gitlab.emse.fr/rootz/le-cercle/-/blob/main/docs/wiki/deployment.md#state)),
closing the backup-completeness gap this same audit found. Production's window ran
`2026-09-24T18:17:50Z`-`18:26:39Z` (8m49s):
`pg_dump`/restore of `auth_db` plus the three object-storage volumes, verified with the same
per-table content fingerprint methodology `cercle` and `miconnect` used - **53/53 tables identical**,
spot-checked against the documented false-positive trap (two sides silently agreeing on the same
error rather than the same content). The relay flipped (`:8080` on the old box -> `127.0.0.1:8081`
on the target) and `https://canari-emse.fr/api/version` answered `200` through the full chain, the
target's own nginx access log naming `10.0.0.3` as the client. The old box's 12 production
containers are `Exited (0)` under `unless-stopped`.

**One real defect surfaced mid-window and is now a durable rule
([durable-rules](../durable-rules.md#the-shared-host-and-what-it-does-to-every-operation---estate-migration)):
Garage's data and meta volumes were restored while the `garage-1` container consuming them was still
running.** It had generated a fresh node identity in memory against the empty volumes at first boot;
the restore then overwrote the on-disk state underneath it, and the two diverged -
`ServerConn::run: Handshake error: performing handshake: failed opening client secret box`. Fixed by
stopping the container before mutating its volume, never the reverse: `docker compose stop garage`,
`rm -f`, then `up -d` to force a clean re-read, healthy within ~45 s. Two rehearsal-only defects were
caught and fixed BEFORE the real window, exactly because both estates were stood up empty and torn
down first: the exact pre-rename commit (`ffbe54731`) still declared `name: infrastructure`, patched
live on the target's checkout to `canari-prod`; and `FRONTEND_HOST_PORT=8080`, copied verbatim from
the old box's `.env`, collided with the shared host's own `crowdsec` - the nginx vhost had already
anticipated `8081`, the `.env` had not been reconciled with it.

**Dev was seeded from the target's own live `canari-prod`, not migrated from the old box's separate
dev database** - the architecturally correct source, since dev is always a disposable periodic copy
of production and never independently authoritative
([dev-environment](dev-environment.md)). `copy-prod-to-dev.sh` ran for real on the target:
442/442 users, every strip verified (push tokens, Stripe customer ids and media references all zero
afterward). The script itself carried the same stale project name production's rename had already
made wrong (`PROD_PROJECT="infrastructure"`, needed `"canari-prod"` now that both projects share a
box and the script finds them by label) - patched live to unblock the copy, fixed properly in
[PR 1073](https://github.com/emse-students/canari/pull/1073) along with the same defect in
`infrastructure/local/pull-prod-dump.sh` (`PROD_HOST="canari"`, which now only reaches the relay, not
the box running postgres). Dev's relay flipped the same way as prod's (`127.0.0.1:3080` on the old
box), `https://dev.canari-emse.fr/api/version` answered `200` with the target's access log showing
the request's full `X-Forwarded-For` chain ending in `10.0.0.3`, and the old box's 11 dev containers
are stopped.

## 7. Phase 2 - the names

`canari-emse.fr` -> `canari.emse.fr`, `cercle.canari-emse.fr` -> `cercle.emse.fr`,
`auth.canari-emse.fr` -> `miconnect.emse.fr`. Dev does not appear: it goes internal.

**Every name costs a DSI ticket - there is no delegated zone and no wildcard**, so they are all
requested at once, together with the two questions the nginx configuration cannot be written
without.

| Ask | Note |
| --- | --- |
| `canari.emse.fr` | **DONE 2026-09-24, no ticket ever needed.** The vhost's `proxy_pass` pointed at `127.0.0.1:3000` (the portal's port, hence `Portail Etudiant ICM`); repointed to `127.0.0.1:8081` (Canari's, matching `canari-prod.conf`), `nginx -t` + reload, verified live: `canari.emse.fr` now serves Canari, `portail-etu.emse.fr` and `canari-emse.fr` unaffected. The DNS record and the GEANT TCS certificate (`/etc/certs/canari.emse.fr/`, issued 2026-09-22, valid to 2027-04-09) already existed - this row never belonged in a DSI request |
| `cercle.emse.fr` | new. The School reserves `etu.emse.fr` for mail, so it is not `cercle.etu.emse.fr` |
| `miconnect.emse.fr` | new |
| AAAA for the above | only if the host has a v6 address. Nothing blocks on it |
| The certificate path, and one SAN certificate or one per name | **ANSWERED by measurement 2026-09-24, leave it out of the request**: one certificate per name, GEANT TCS, no ACME - see above |
| Confirm 80/443 inbound are already open | the machine already serves `portail-etu.emse.fr`, so this is expected to be a no-op |

**TURN is deliberately NOT in that request.** It needs an inbound UDP range, which is a different
kind of ask and is refused more easily than a DNS record; attaching it would put the whole list at
risk. It goes in its own request when calls are revived ([calls](../frontend/modules/calls.md)).

### The request, written out - copy it, do not rewrite it

**One message, every name at once**, because every name costs a ticket and a second request is a
second wait. The certificate question that used to be in the table is GONE from it: it was answered
by measurement above, and a request that asks what the asker could have read is a request that gets
a slower answer.

**The block below is the message, and it carries French accents on purpose** - it is text to be
SENT, not documentation prose, and `Portail Etudiant ICM` is not how that site spells its own name.
Everything around it stays ASCII like the rest of this repository.

```text
Objet : demande d'enregistrements DNS et de certificats pour deux noms (association Canari)

Bonjour,

L'application Canari (association etudiante, actuellement sur canari-emse.fr) et les
services qui l'accompagnent vont etre heberges sur la machine 193.49.175.67, celle qui
sert deja portail-etu.emse.fr. Nous souhaitons a cette occasion passer sous emse.fr.

1. Creation de deux enregistrements A vers 193.49.175.67 :
     cercle.emse.fr
     miconnect.emse.fr

2. Pour information, sans demande de votre part : canari.emse.fr pointe deja vers
   193.49.175.122, une adresse de cette meme machine, et son certificat a ete renouvele
   le 22/09/2026. Ce nom renvoyait le Portail Etudiant ICM, une configuration nginx
   restee en place ; nous l'avons corrigee cote machine le 24/09/2026 et il sert
   desormais Canari.

3. Un certificat par nom pour les deux noms du point 1, livre comme les autres dans
   /etc/certs/<nom>/ sur 193.49.175.67.

4. Confirmation que les ports 80 et 443 entrants sont bien ouverts sur 193.49.175.67
   (la machine sert deja portail-etu.emse.fr, donc nous pensons que oui).

5. Si la machine possede une adresse IPv6, les enregistrements AAAA correspondants.

Merci d'avance,
```

**What is deliberately NOT in it**: TURN's inbound UDP range, which is refused more easily than a
DNS record and would put the whole list at risk, and `dev`, which goes internal and needs no public
name at all.

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

### A browser cannot follow a redirect and keep its state - there must never be one

Native apps are unaffected by which public host is used: `mls.bin`, the SQLite message database and
the device key all live on the OS filesystem under the app's own identity (`fr.emse.canari`), not
under a public hostname - the WebView itself never navigates away from `tauri://localhost` /
`tauri.localhost`, and a deep link only tells the OS which installed app to open. Confirmed by
reading `IMlsService.ts` ("`mls.bin`... meaningless on the web") and `mlsStatePersister.ts`, whose
equivalent checkpoint on the WEB build is written to **IndexedDB**, which every browser partitions
strictly per origin.

`https://canari-emse.fr` and `https://canari.emse.fr` are two unrelated origins to a browser, with no
shared registrable-domain suffix a cookie's `Domain=` could bridge. Nothing - no redirect, no API -
moves IndexedDB, `localStorage` or a cookie between them. A browser session that lands on
`canari.emse.fr` for the first time therefore starts from **zero**: no cached history, no MLS
ratchet state, no refresh-token cookie (forced re-login), and cryptographically it looks exactly like
adding a brand-new device to every conversation that browser was in - which depends on the healing/
welcome path the queue already documents as unreliable (item 6, ~3 successes in 10).

**Measured 2026-09-24: nothing in this repository or on the target's nginx does this today.**
`canari-prod.conf` and `canari.conf` carry no cross-host redirect in either direction, and
`DEFAULT_PUBLIC_APP_ORIGIN` in `publicAppUrl.ts` deliberately stays `canari-emse.fr` - outbound share
links are not migrated either. The "`canari-emse.fr` keeps answering with 301s indefinitely" line
above is about its ordinary HTTP-to-HTTPS upgrade, not a cross-domain one.

**The rule going forward: no server-side redirect and no client-side canonicalization may ever send
an existing `canari-emse.fr` browser session to `canari.emse.fr`.** `canari.emse.fr` may exist,
resolve and be linked to for NEW visits, but an existing session's origin is not something this
migration can or should move. If the old host is ever decommissioned, browser users need an explicit,
in-app warning and a chance to be re-added before their storage becomes unreachable - never a silent
redirect.

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
- **creating the new Cloudflare tunnel on `rootz-emse.fr` - AND IT MAY NOT BLOCK PHASE 1 ANY MORE.**
  A new tunnel would have to run on the target host, where 7844 is refused, so that plan is dead as
  written; if the old VM's web server proxies to the new host instead, phase 1 needs NO Cloudflare
  change at all and this ceases to be a blocker. **That is the first thing to settle** - the
  paragraph below is kept because the measurement in it is still the reason a tunnel cannot be
  created from here.
  The project's token cannot do it, measured 2026-09-02 and again 2026-09-24 with the same result:
  `POST /accounts/{acct}/cfd_tunnel` answers `10000 Authentication error`, `GET` answers 200 with
  an EMPTY list while production runs a tunnel, and Access groups answer 403. A tunnel is a
  dashboard gesture ([cloudflare-edge](cloudflare-edge.md)). Everything up to step 3 of phase 1 can
  be done without it; step 4 cannot. The alternative to the gesture is an API token carrying
  `Cloudflare Tunnel: Edit` on the account;
- ~~the rights request~~ **GRANTED 2026-09-23** - `docker` plus `ALL=(ALL) NOPASSWD:ALL`, wider
  than the narrow rule asked for; the older `boudin` account is gone and left no orphaned FILE
  behind, though it did leave a **membership**: `getent group docker` still named it on 2026-09-24,
  a group entry for a uid that no longer resolves. Removed. `deluser` does not sweep supplementary
  groups, and nothing on a box reports one (section 2);
- **the arbitration on capacity**: 4 vCPU and 11 G against three VMs sized for 8 and 20. Either the
  VM grows, or what moves onto it is cut down. Nobody can decide that here;
- nothing further on SSH: the touch is gone and access is unattended (section 2).

## 9. Open questions

| Question | Who answers | Why it blocks something |
| --- | --- | --- |
| ~~Will the DSI grant `docker` and a narrow `sudo`?~~ | **ANSWERED 2026-09-23: both granted** | - |
| Does Canari's data land on local `/` (45 G, **32 free** since the 2026-09-24 cleanup) or on the NetApp `/export` (24 G, 15 free)? | user with the DSI | they differ in size, free space and recovery; section 5 cannot be written without it. The local disk grew by 5 G, so the question is now about recovery and snapshots rather than about room |
| What kills a bulk `rm` here, and will it kill a volume restore during the cutover? | DSI, one question | a cutover that dies half-way with no diagnostic is the worst failure mode in this plan |
| 4 vCPU and 11 G for everything, or does the VM grow? | user, then DSI | it decides whether all three estates move, or only some |
| ~~What are the file NAMES inside `/etc/certs/<name>/`?~~ | **ANSWERED 2026-09-24, by that one command** | `cert.pem`, `chain.pem`, `fullchain.pem`, `privkey.pem` - the Let's Encrypt layout - with the key `0600 root:root`, which nginx's root master reads. **`/etc/certs/canari.emse.fr/` ALREADY EXISTS and is complete**: the DSI issued that certificate before any request was made. another association's retired vhost also still has one |
| ~~Is `193.49.175.122` the same machine as `193.49.175.67`?~~ | **ANSWERED 2026-09-24: yes, measured** | `ens18` carries `.67`, `.40` and `.122`. Section 2 |
| ~~What of the shared box's legacy is ours to clean?~~ | **ANSWERED 2026-09-24 by the user, and DONE** | The nine php-fpm versions, apache2, phpMyAdmin and MySQL are gone; the databases are archived rather than destroyed. What was NOT touched is named above: the host's DSI-managed security agent stays at the version it had, because an agent newer than the DSI's central manager is unsupported - the product, its version and the manager's address are in the operator's local notes and not here, `isc-dhcp-client` stays because this machine is reached only over SSH, and the other associations' web roots under `/export/www` are untouched |
| Production's Postgres volume size | one command on `canari` | the read-only window is quoted from it |
| Does Portail-etu become a compose project with a declared `name:` and ceilings like the others? | user | it is the only estate that would not, and the standing mandate is homogeneity everywhere |
| What was `zookeeper` for, and why is Authentik's database volume on Canari's VM? | nobody has asked | both are dropped by not being recreated, unless one of them turns out to matter |
| What becomes of the Proxmox host once every VM is off it | user, not yet decided | it is the obvious destination for the reworked backups |

## 10. THE ORDERED LIST - written 2026-09-24, DATA AND TRAFFIC NOW DONE FOR ALL THREE ESTATES

All three estates' data and traffic are on the target: `cercle` and `auth.canari-emse.fr` since
midday, `canari-emse.fr` and `dev.canari-emse.fr` since the evening - Canari's own move was two
estates and a CI runner, not one estate
([reasoning](#canari---moved-2026-09-24-it-was-two-estates-and-a-ci-runner-not-one-estate)), and the
naming and Postgres-timing decisions it raised were settled in section 4. **Steps 5 and 6's runner
half is DONE too, as of the same evening** - nothing in this list remains open; phase 1 is complete
for all three estates. The runbook in section 6 says HOW each step was shaped, and carries Canari's
own write-up.

1. **DONE 2026-09-24: Canari's runner is registered on the target, STOPPED AND DISABLED.**
   Org-level, name `canari`, group `canari`, `/opt/actions-runner/runners/canari`, `User=gha-runner`.
   It was started once to prove registration, then stopped: both it and the Portail-etu runner
   answer to the same bare `self-hosted` four jobs ask for, so a release published before the
   estates move could otherwise land on the empty one. **Re-enabling it is step 6, not step 1** - it
   happens last, in the window, with the old runner stopped in the same breath, or the same race
   reopens from the other side.
2. **DONE 2026-09-24: the two CHECKOUTS exist on the target** - `/srv/canari` and `/srv/canari-dev`,
   clean clones of `origin/main`, owned by `gha-runner`. Not compose directories, unlike the other
   two estates: Canari's estates are clones of THIS repository that the deploy `git reset --hard`s
   into, and the deploy paths are still LITERALS in the workflows today (`DEPLOY_PATH:
   /home/canari/canari` in `serve-prod.yml`, `DEV_DEPLOY_PATH: /home/canari/canari-dev` in
   `serve-dev.yml`) - moving them to `/srv/canari` and `/srv/canari-dev` is still a commit owed here,
   not a server-side gesture, and it is NOT this one. **The two halves do not self-heal the same
   way**: `serve-dev.yml` clones when it finds no `.git`, `serve-prod.yml` assumes the checkout
   exists - a move that trusts both would leave production's first deploy failing on a missing
   directory while dev comes up and makes the migration look successful.
3. **Declare `name: canari-prod` and `name: canari-dev` and repoint EVERY `DEPLOY_PATH` literal
   to `/srv/canari` and `/srv/canari-dev`, IN ONE COMMIT, and DO NOT MERGE IT BEFORE STEP 6.**
   THREE literals, not two: `serve-prod.yml`, `serve-dev.yml`, and a hardcoded `path=` inside
   `scheduled.yml`'s `dev-refresh` job - the plan naming only two here was itself stale until
   2026-09-24, and would have left the Monday refresh pointed at the OLD box after the cutover with
   no warning before the next run. A THIRD hazard sits in the same rename: `backup.sh`,
   `backup-objects.sh` and `restore.sh` each mount named volumes with a raw `docker run`, outside
   `docker compose`, so nothing in them resolves the project name from the file - they had
   `infrastructure_garage_data` and its two siblings written IN, which a rename alone would have
   silently pointed at volumes that do not exist, producing an empty archive with no error.
   Factored into one `CANARI_COMPOSE_PROJECT` variable (default `canari-prod`) reused across all
   three scripts and documented in `infrastructure/backup/README.md`, in the SAME commit. None of
   the three hazards is independent of the others, and the ordinary `gh pr create` cycle ships the
   moment CI is green - there is no draft state in this repository's CI/CD to hold it. Renaming the
   project ahead of the physical move brings the CURRENT box up on volumes that do not exist at its
   next ordinary deploy (met once already on Authentik); repointing the paths ahead of it breaks the
   CURRENT box's very next deploy, refresh and backup outright, since none of the renamed targets
   exist there. **Prepare the branch, hold the PR, open it only as part of step 6.**
4. **Write the target vhosts and the relay, on the pattern `cercle` and `miconnect` already prove.**
   **DONE 2026-09-24 on the target's half**: `canari-prod.conf` (`canari-emse.fr` ->
   `127.0.0.1:8081`) and `canari-dev.conf` (`dev.canari-emse.fr` -> `127.0.0.1:3080`) are
   written, `nginx -t` passed, reloaded - verified from outside with `Host`-header routing (a clean
   `502 Connection refused` on each, not a config error, and `cercle`/`miconnect` unaffected by the
   reload). **DONE 2026-09-24 on the old-VM half too.** The claim this step's plan carried - that the
   `canari` box has NO system nginx at all - was WRONG: nginx 1.26.3 is a pre-existing Debian package
   there, `inactive`/`disabled` since a pre-containerization setup dated March 2026, not absent. It
   needed enabling, not installing: `canari-relay-prod.conf` (`:8080` -> the target) and
   `canari-relay-dev.conf` (`127.0.0.1:3080` -> the target), `nginx -t` passed, `systemctl enable
   --now nginx`, both verified end to end through the real public names with the target's own access
   log naming `10.0.0.3` as the client - the same proof `cercle` and `miconnect` used.
5. **DONE 2026-09-24 - move the crontab and every remaining path naming the old box.** The three
   cron lines (nightly backup, object backup, per-minute egress probe) already ran from the target
   under `gha-runner` since the runner flip below; the old box's own crontab was backed up
   (`/home/canari/backups/crontab.removed-2026-09-24.bak`) then removed entirely (`crontab -r`),
   confirmed empty. `MICONNECT_SSH_HOST` needed no change: Authentik colocated on the target the
   same day, so `backup.sh`'s local path (`MICONNECT_PG_CONTAINER`) already applied - see the
   crontab comment on the target. A backup that still writes to an unwatched VM is indistinguishable
   from one that works, until it is needed.
6. **DONE 2026-09-24, in full - data, relay AND runner.** Prod's window: dump, restore, verify by
   content fingerprint (53/53 tables), flip the relay, stop the old containers - see the write-up
   below. Dev was not dumped from the old box at all: it was seeded from the target's own now-live
   `canari-prod` via `copy-prod-to-dev.sh`, which is the architecturally correct source (dev is
   always a disposable copy of prod, never independently authoritative - `dev-environment.md`). The
   target's org-level `canari` runner was enabled and started (`gh api
   orgs/emse-students/actions/runners` confirms `online`); the old box's repo-level `Canari` runner
   was stopped and disabled the same way every other systemd change on that box went, through the
   docker-chroot route, since that account's `sudo` needs a password this account does not hold -
   confirmed `offline` via `gh api repos/emse-students/canari/actions/runners`.

**Loose ends, small and real.** Two manual `authentik_db_2026-09-24_manuel.sql.gz` copies (27 MB
each, on `canari` and on `mitv`) sit outside the 14-day purge, which only matches `*.tar.gz` - they
were the safety net taken before the backup chain was repaired; delete them once one SCHEDULED run
has produced an archive containing Authentik, not before, and deleting a backup is the user's
gesture. `fix/batch-diagnostic-reads-the-app-not-the-document` is the one local branch still kept
(`wt-devtools` worktree, an eight-line comment and one backlog row) - ship it or drop it
deliberately.
