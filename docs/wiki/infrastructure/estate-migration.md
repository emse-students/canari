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
- **THE TOUCH IS GONE, AND THE HARDWARE-BACKED WAY OF REMOVING IT FAILED FIRST.** Access is
  unattended since 2026-09-23: `id_ed25519` - the ordinary key that already opens `canari`,
  `cercle`, `miconnect` and GitLab - now sits in the account's own `authorized_keys`, measured at
  four consecutive connections, ~1.4 s each, no gesture. The FIDO key stays installed and still
  works, and `bastion` keeps using it because its `authorized_keys` is DSI-managed.
- **Do not retry the hardware route here.** An `ed25519-sk` key created with `-O no-touch-required`
  was installed with the matching `authorized_keys` option and the server **ACCEPTED it** -
  `Server accepts key` is in the trace. Signing then failed on this workstation with
  `ssh-sk-helper: Signing failed: requested feature not supported` at `flags 0x00`: the FIDO
  provider will not produce an assertion without user presence. **The blocker is the authenticator
  chain, not the server**, so the real choice was never "same guarantees, fewer gestures" - it was a
  software key or one gesture per command, and the software key is the one the rest of this estate
  already trusts.
- The FIDO key remains `id_ed25519_sk`, and **`ControlPersist` IS STILL NOT A LEVER** -
  measured on this workstation 2026-09-23 and REFUTED. The master starts, it daemonises, and
  `ssh -O check` reports `Master running`; every client that presents itself is nonetheless reset
  and silently falls back to a fresh connection. The tell is the clock: 7 to 10 seconds and one
  touch per command, where a reused socket costs about 20 ms. MSYS emulates the Unix domain socket
  over Windows and multiplexing does not survive the emulation; native Windows OpenSSH does not
  implement `ControlMaster` at all, so no configuration fixes this. Every connection is therefore a
  fresh TCP handshake and a fresh authentication, about 1.4 s. That is now a cost in seconds rather
  than in human gestures, so **batching a survey into one `ssh ... <<'REMOTE'` heredoc is a
  courtesy, not the constraint it was for the few hours the FIDO key was the only way in.**
- **This does not constrain CI.** Portail-etu deploys from a self-hosted runner installed ON the
  box, which pulls the code itself. The same shape is what Canari, le Cercle and Authentik will
  use, so no deploy path ever needs SSH.
- `canari.emse.fr` **already resolves**, to `193.49.175.122`, and serves Portail-etu byte for byte
  (identical `ETag`). The name has to be reclaimed, not created. **IT IS THE SAME
  MACHINE, AND THAT IS MEASURED ON THE BOX SINCE 2026-09-24**: `ip -4 -o addr show ens18` returns
  `193.49.175.67/24`, `193.49.175.40/24` and `193.49.175.122/24` on one interface. The probe that
  sat against it - `.67:22` answering an SSH banner while `.122:22` is dropped - was the
  per-address firewall rule, which is exactly the alternative reading the paragraph allowed for.

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

**AND THAT PREPARED VHOST ALREADY ANSWERS - WITH THE NEIGHBOUR'S SITE.** `sites-enabled/canari.conf`
proxies to `127.0.0.1:3000`, which is the port Portail-etu's own container publishes, and a request
carrying `Host: canari.emse.fr` returns **HTTP 200 and the Portail-etu page**. It is a copy of the
neighbouring vhost, written before anything of ours existed to point at. Nothing is broken today
because no DNS record sends traffic there - **but the day phase 2 creates that record, Canari's
production name serves Portail-etu until that one line is changed.** The host port allocation table
section 5 asks for is therefore owed BEFORE the DNS request, not after it.

| | Target host | The three VMs to absorb |
| --- | --- | --- |
| vCPU | **4** (QEMU, AVX2 present) | 8 |
| RAM | **11 G**, 1.6 in use | 20 G allocated |
| Disk | **50 G, fully partitioned, no LVM**; 25 G free | 49 G, of which ~33 G is debris that does not move |

**The disk cannot be grown from here.** `sda` is 50 G, `sda1` takes 46 and `sda5` is 4 G of swap;
with no LVM, enlarging it is a DSI action on the VM, not a command. Of the 18 G in use, **2.6 G is
the systemd journal** - reclaimable, but not by us.

**THE ACCOUNT NOW HAS WHAT IT NEEDED, granted 2026-09-23.** `jolan.boudin` is in `docker` and
carries `ALL=(ALL) NOPASSWD:ALL` in `/etc/sudoers` - broader than the narrow rule this plan asked
for, so the restraint is the operator's now rather than the system's. The older `boudin` account was
deleted in the same gesture, and **the caveat that travelled with that deletion is closed**: a sweep
of the whole root filesystem for every uid with no account behind it returns nothing.

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

### THREE TRAPS THE HOST SETS FOR A MIGRATION - MEASURED 2026-09-23

**A BULK FILE DELETION IS KILLED PART-WAY, AND NOTHING SAYS SO.** An `rm -rf` over a few hundred
files died on `SIGKILL` half finished. It was not the OOM killer - 10 G were free, and `dmesg`
carries no `Killed process` line - and `journalctl` records nothing at all for the minute it
happened. The host places an anti-ransomware DECOY file in every home directory, in `/root` and in
every web root (one of them a `.php`, inside the web tree); no package owns them, and a DSI-managed
EDR agent runs permanently. The deletion stopped on the decoy. **Consequence binding every phase
below: any bulk file operation - restoring a volume, emptying a directory, an unfiltered
`docker system prune` - can be killed half-way with no diagnostic.** So work in small batches,
**verify the resulting state rather than the exit status**, and never read "the command printed no
error" as "the operation completed". This is the durable rule about a correct mechanism with no
report, arriving from the other direction: here the mechanism is someone else's, and its report does
not reach us at all.

**`/export` IS A NETAPP FILER AND `/` IS NOT - TWO STORAGE CLASSES, NOT ONE DISK.** The root
filesystem is 45 G of local ext4 with 27 G free. `/export`, which carries the association web roots,
is NFS from a filer: **24 G with about 14 G free**, holding daily and weekly `.snapshot/` trees and a
`vserverdr` replication. The capacity table above therefore measures only one of the two, and
**section 5 owes an explicit answer on which class Canari's data lands on** - they differ in size,
in free space and in recovery properties. Two further consequences: a snapshot tree is **not a
backup this project controls**, and space freed by a deletion there is still held by the snapshots
that predate it.

**UID RECYCLING HAS ALREADY MISATTRIBUTED FILES THREE TIMES ON THIS BOX.** `useradd` hands out the
lowest free uid, so deleting an account without deleting its files arms a trap: the next account
created inherits the uid and silently owns them. Three home directories here were owned by living
accounts that had never written a byte in them, and roughly 8000 files under `/usr/lib` were
attributed to a person who arrived years after they were installed. **`find -user` is not evidence
of authorship on this machine.** An account removed during this chantier must lose its files in the
same operation, and any account created here should be given an explicit uid above the high-water
mark rather than the lowest free one.

### THE HOST WAS EMPTIED BEFORE THE MOVE - 2026-09-24

The survey above found a shared box carrying years of other people's leftovers. It now carries
**796 packages where it carried 1813**, and the difference is the surface this project would
otherwise have inherited.

| Removed | What it was |
| --- | --- |
| **nine** concurrent PHP versions, 7.0 through 8.4 | 175 packages. Exactly ONE was referenced by nginx - `php8.2`, and only for phpMyAdmin |
| apache2 | installed, inactive, listening on nothing |
| phpMyAdmin | the `/linterfacelephp` vhost location, now `404` |
| MySQL, engine and data | eleven legacy databases, nothing connected to it |
| 111 `rc` residues | config left by packages removed years ago, down to `linux-image-4.19` |
| the desktop trees | WebKit, GTK 3 and 4, Mesa and Vulkan, three obsolete GCC toolchains, LLVM 19, X fonts, a speech-recognition model |

`/` went from 16 G used to **12 G, leaving 32 G free where the capacity table measured 27**, and
`/etc` is under version control again: etckeeper had not committed since 2019-07-31 and 1882
pending changes were carried into one commit that dates this cleanup.

**Every check after each batch was on the STATE, never on the exit status** - the `rm` that
SIGKILLs is on this same machine. Twelve services and four vhosts were re-verified after each step;
Portail-etu answered `200` throughout.

**MySQL is the one that needed evidence before it could go.** Nothing reached it: no process on its
socket, no systemd dependency, no container, and the Portail-etu container declares no database
variable at all. Its last write was `cercle`'s, on 2026-09-11 - and the monthly histogram shows why
that is not a live system: 917 transactions in June 2026, **1 in July, 58 in August (a single bar
shift, `perm` 917) and 1 in September**. The pre-Canari bar system stopped in June; what followed is
a tail. Confirmed by the user: it is `ssh cercle` that replaced it.

The dump is verified in four places - `/var/backups`, `/var/lib/automysqlbackup` (234 M),
`/export/mysqlbackup` (96 M on the filer) and the user's workstation, md5 checked against the host.
**What would have talked to a MySQL that is gone was DELETED in the same breath**, because a daily
cron failing into a mailbox is the noise nobody reads: two backup crons and one Zabbix
`userparameter_mysql.conf`. Renaming them aside was the first instinct and it was wrong - a
disabled thing is a thing a later reader has to re-decide.

### AIDE reported nothing for two and a half years, and three separate defects stood between it and a report

`/var/lib/aide/aide.db` was absent and the `aide.db.new` dated 2024-02-12 had never been promoted;
the daily unit sat in `failed`. Rebuilding the baseline was the easy part, and it was not enough.

**The exclusion syntax was wrong twice, and only a 9317-line run said so.** AIDE's `!<regex>` is a
RECURSIVE negative rule: the manual says the children of matching directories *are recursed into*
and merely not added to the database. So `!/export` excluded the NetApp filer from the baseline
while still walking every `.snapshot` tree the filer recreates daily. `-<regex>`, added in AIDE
0.19, is the one that prunes. **`--path-check` settles which rule wins for a given path in one
second**, against twelve minutes for a rebuild, and it is how each exclusion below was verified
rather than assumed:

| Pruned | Why |
| --- | --- |
| `/run/rpc_pipefs` | the NFS client's pseudo-filesystem; its entries declare a null size and return content, so every run warned on them |
| `/run/docker`, `/run/containerd` | container network namespaces, whose id is random per start - on a Docker host that is a permanent report of files appearing and vanishing |
| `/export` | the NetApp mount and its daily `.snapshot` trees |
| `/var/lib/docker`, `/var/lib/containerd` | 51007 entries that every build and every deploy rewrites |

`/etc`, `/usr/bin` and `/etc/shadow` remain watched - checked, not assumed.

**And the report reached nobody.** Debian runs AIDE as `_aide` with `CAP_DAC_READ_SEARCH`, and that
capability disables the suid bit the traditional `sendmail` interface needs; the package's own
README says a non-root AIDE on systemd can only mail through `s-nail`, which was absent. **Worse,
`/etc/aliases` sent root's mail to an address that no longer exists** - the Rootz address is dead,
and `/var/log/mail.log` shows system mail still being sent to it hours before this was found. Half
of every alert this machine has raised, for however long, went into the void. The alias now names a
live Rootz mailbox beside the DSI's, and delivery was proven end to end: a report sent AS `_aide`
arrived.

**This is the durable rule about a correct mechanism with no report, met three times in one
afternoon**: a baseline that was never promoted, a monitor whose output would have been unreadable,
and a delivery path that silently dropped half its recipients. None of the three would have shown
up in a green check.

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

**THE `30xx` ABOVE ARE NOW CHOOSABLE, BECAUSE THE HOST'S LOOPBACK HAS BEEN ENUMERATED** (2026-09-24).
This is the table section 8 owed BEFORE the DNS request, since the prepared `canari.conf` already
proxies to `127.0.0.1:3000` - which is Portail-etu's.

| Port | Held by |
| --- | --- |
| 22 | `sshd` |
| 80, 443 | host nginx |
| 111 | `rpcbind` |
| **3000** | **the Portail-etu container - what `canari.conf` currently points at** |
| 6060, 7422, 8080 | CrowdSec |
| 10050 | Zabbix agent |
| 44855 | containerd |

Nothing else listens. `3001`, `3002` and `3003` are free for `canari-prod`, `cercle` and
`authentik`, and the removal of five php-fpm sockets took five more consumers off the box.

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
- ~~the rights request~~ **GRANTED 2026-09-23** - `docker` plus `ALL=(ALL) NOPASSWD:ALL`, wider
  than the narrow rule asked for; the older `boudin` account is gone and left no orphaned file
  behind (section 2);
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
| ~~What are the file NAMES inside `/etc/certs/<name>/`?~~ | **ANSWERED 2026-09-24, by that one command** | `cert.pem`, `chain.pem`, `fullchain.pem`, `privkey.pem` - the Let's Encrypt layout - with the key `0600 root:root`, which nginx's root master reads. **`/etc/certs/canari.emse.fr/` ALREADY EXISTS and is complete**: the DSI issued that certificate before any request was made. `handimines.emse.fr` also still has one, for a vhost this cleanup retired |
| ~~Is `193.49.175.122` the same machine as `193.49.175.67`?~~ | **ANSWERED 2026-09-24: yes, measured** | `ens18` carries `.67`, `.40` and `.122`. Section 2 |
| ~~What of the shared box's legacy is ours to clean?~~ | **ANSWERED 2026-09-24 by the user, and DONE** | The nine php-fpm versions, apache2, phpMyAdmin and MySQL are gone; the databases are archived rather than destroyed. What was NOT touched is named above: `wazuh-agent` stays at 4.14.7 because an agent newer than the DSI's manager on `193.49.175.93` is unsupported, `isc-dhcp-client` stays because this machine is reached only over SSH, and the other associations' web roots under `/export/www` are untouched |
| Production's Postgres volume size | one command on `canari` | the read-only window is quoted from it |
| Does Portail-etu become a compose project with a declared `name:` and ceilings like the others? | user | it is the only estate that would not, and the standing mandate is homogeneity everywhere |
| What was `zookeeper` for, and why is Authentik's database volume on Canari's VM? | nobody has asked | both are dropped by not being recreated, unless one of them turns out to matter |
| What becomes of the Proxmox host once every VM is off it | user, not yet decided | it is the obvious destination for the reworked backups |
