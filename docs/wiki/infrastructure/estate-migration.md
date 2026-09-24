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

- **WHO REACHES THIS HOST, WITH WHICH KEY, AND FROM WHICH WORKSTATION IS DELIBERATELY NOT WRITTEN
  HERE.** It named a personal login, a second account beside it, the key files on one machine and
  the second factor that was removed from them - an access map for a host this project does not
  own, in a PUBLIC repository. It is machine-local wiring, so it lives in the agent's local memory
  with the other host-access notes, and this page keeps only what the MIGRATION needs.
- **Access is unattended since 2026-09-23** - four consecutive connections, ~1.4 s each, no gesture.
  What matters here is the cost rather than the credential: every connection is a fresh handshake,
  because connection multiplexing is **REFUTED on this workstation**. The master daemonises and
  `ssh -O check` reports `Master running`; every client that presents itself is nonetheless reset
  and silently falls back. MSYS emulates the Unix domain socket over Windows, and native Windows
  OpenSSH does not implement `ControlMaster` at all, so no configuration fixes this. **Batching a
  survey into one `ssh ... <<'REMOTE'` heredoc is a courtesy, not the constraint it once was.**
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

**THE ACCOUNT NOW HAS WHAT IT NEEDED, granted 2026-09-23.** It is in `docker` and carries
`ALL=(ALL) NOPASSWD:ALL` in `/etc/sudoers` - broader than the narrow rule this plan asked for, so the
restraint is the operator's now rather than the system's. The older, separate account that used to
hold those rights was deleted in the same gesture, and **the caveat that travelled with that deletion is closed**: a sweep
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
**787 packages where it carried 1813**, and the difference is the surface this project would
otherwise have inherited.

| Removed | What it was |
| --- | --- |
| **nine** concurrent PHP versions, 7.0 through 8.4 | 175 packages. Exactly ONE was referenced by nginx - `php8.2`, and only for phpMyAdmin |
| apache2 | installed, inactive, listening on nothing |
| phpMyAdmin | the `/linterfacelephp` vhost location, now `404` |
| MySQL, engine and data | eleven legacy databases, nothing connected to it |
| 111 `rc` residues | config left by packages removed years ago, down to `linux-image-4.19` |
| the desktop trees | WebKit, GTK 3 and 4, Mesa and Vulkan, three obsolete GCC toolchains, LLVM 19, X fonts, a speech-recognition model |
| the sury repository | **removing PHP is not removing its archive.** `packages.sury.org` stayed declared, stayed in `unattended-upgrades`, and still owned three installed packages - among them `libpcre3`, a PCRE 1 whose upstream ended in 2021 and which nothing depended on. Repository, keyring, origin line and the three packages are gone |

`/` went from 16 G used to **12 G, leaving 32 G free where the capacity table measured 27**, and
`/etc` is under version control again - 1882 pending changes carried into one commit that dates
this cleanup, and a second commit for the batches that followed.

**THAT REPOSITORY IS NOT ETCKEEPER, AND SAYING IT WAS NAMED A MECHANISM THAT NEVER EXISTED.** The
first version of this paragraph read "etckeeper had not committed since 2019-07-31". There is no
`etckeeper` package on the box and no `/etc/etckeeper/` at all: `/etc/.git` is a repository the
DSI's own staff drove BY HAND, fifteen commits, each subject prefixed with the initials of whoever
typed it, the last on 2019-07-31. So the two new commits follow that convention rather than
introducing a daemon onto someone else's machine - **and the standing rule about a stale claim
cuts both ways: it must name the mechanism that would honour it AND show that mechanism gone, not
invent one from the shape of the evidence.** Installing `etckeeper` would be an improvement and it
is the DSI's call, not ours.

**The runner's token is excluded from it** (`/etc/.git/info/exclude`). The repository already
tracks `/etc/shadow` and `/etc/.git` is `0700 root:root`, so this is not about who can read it: a
CI credential is revoked and replaced on a schedule that has nothing to do with configuration, and
it does not belong in a history of configuration.

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

**A REPOSITORY OUTLIVES THE PACKAGES IT SHIPPED, AND NOTHING SAYS SO.** The nine PHP versions went
in the first pass; `packages.sury.org` was still declared a week later, still listed as a trusted
origin for unattended upgrades, and still the source of `libgd3`, `libpcre3` and its own keyring.
Nothing failed, nothing warned - `apt update` fetched an index for a distribution that no longer had
a reason to exist. **The question that finds this is not "what is installed" but "which installed
package still comes FROM here"**, and it is answered by joining the repository's own `Packages`
index against `dpkg-query`, not by reading the removal log.


**AND 160 MB THAT LOOK EXACTLY LIKE RECLAIMABLE BUILD DEBRIS ARE THE LAST COPY OF A DELETED
REPOSITORY.** `/opt/actions-runner/runners/portail-etu/_work/refonte-gala/` is a runner workspace -
`node_modules`, a `build/`, a `.venv`, nothing touched since 2026-01-08 - on a runner whose only
remaining consumer is `refonte-portail-etu`. Every filesystem question said "delete": no process has
it as a cwd, no container mounts it, nothing listens from it, no symlink points in, and a runner
recreates its workspaces anyway.

**The question the filesystem cannot answer is whether the code still exists somewhere else.**
`emse-students/refonte-gala` answers `404` - the repository is GONE - and `Gala-Website`, which
looks like its successor, is a FRESH repository whose earliest commit is 2026-09-23 and which does
not contain this checkout's `HEAD` (`268d218e`, refused with `No commit found for SHA`). So on this
host that directory is the only surviving artefact of a repository nobody can clone any more. It
was left in place, and reclaiming the 160 MB is a question for its owners
([backlog](../backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks)).

**The runner it sits in is ORG-scoped, and that was checked rather than assumed.** Its group is
`visibility: selected` and names exactly one repository, and the only two jobs that ask for
`self-hosted` are the deploy library - called by `release.yml` alone - and the scheduled egress
probe. Neither is reachable from a fork's pull request, which is what would otherwise put a
`docker`-group account on a machine we do not own within reach of a stranger's branch.


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

## 4. The decisions - taken with the user 2026-09-23 and 2026-09-24, NOT TO BE RELITIGATED

| Decision | Value | Why |
| --- | --- | --- |
| Shape on the new host | **Docker compose projects side by side**, not nested virtualisation | simpler, and it is the shape every future project gets |
| Public traffic | **No Cloudflare at all** - nginx, ufw and DSI certificates | the School owns the zone and will not delegate it |
| Internal traffic | stays on **`rootz-emse.fr`** behind a Cloudflare tunnel, with Access | an admin interface does not need a public name, and a gated door does not need a signpost |
| **Where the internal surface RUNS** (2026-09-24) | **it does not move** - dev and the admin interfaces stay on the OLD VM | see below: this is what makes the refused port stop mattering |
| The tunnel | **stays where it already works**, on the old VM (2026-09-24) | nothing is installed on the new host for it, so nothing there needs to reach the edge |
| Dev | **`dev.canari.rootz-emse.fr`**, internal, behind the tunnel, **and hosted on the OLD VM** (2026-09-24) | dev holds a FULL COPY of production data; publishing it under `emse.fr` would expose members' data on a name anyone can reach. Costs no DSI ticket and no third-level certificate |
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

### The 2026-09-24 decision, and why it deletes a chantier instead of solving it

**The new host carries PRODUCTION and nothing else.** Dev and the admin interfaces stay on the old
VM, where the tunnel already runs and already works. Three days of work on the refused port - the
probe table, the A/B against production, a parade that had to be refuted, a relay designed and
measured - were all spent on a door the new host does not need to have.

| What it settles | |
| --- | --- |
| Outbound 7844 on the new host | **no longer a blocker, and not worth a DSI request** |
| The connector installed there on 2026-09-24 | **REMOVED** the same day - unit, `EnvironmentFile`, binary, apt source and keyring; the host is back to its prior state, and the run token no longer sits on a machine shared with other associations |
| The relay from the old VM | **NEEDED after all** - not for the internal door, which no longer moves, but for phase 1's PUBLIC path, whose every step goes through the tunnel. See the relay section |

**AND IT DOES NOT MAKE PHASE 1 TUNNEL-FREE.** Phase 1 preserves the OLD public names, which reach
the edge through the tunnel; only the CONNECTOR's location was settled here. The relay section below
is what carries that, and declaring it unneeded on the strength of this decision was an error made
and corrected the same day.

**The cost the user accepted, stated so nobody re-derives it as a defect**: dev no longer runs on
the same machine as production, so it rehearses the production environment less faithfully than it
would have. That is a deliberate trade against building and maintaining a relay.

**AND ONE THING IS NOT SETTLED BY IT.** Authentik's admin interface is a PATH inside Authentik, not
a separate service, so "the admin interfaces stay on the old VM" cannot hold for it literally: if
`miconnect` moves, its admin moves with it. Either `miconnect` stays put too, or its admin path is
reached some other way. **Do not assume this was decided** - it was not asked.

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

### GROUNDWORK LAID 2026-09-24 - NOTHING IS SERVING YET, AND THAT IS THE POINT

Three pieces of step 1 exist on the target host. **No ingress moved, no name changed, and the old
estate has not been touched** - the user's instruction was to be ready, not to switch.

**`cloudflared` 2026.9.1 is installed and configured with nothing.** The Cloudflare apt repository
is declared in deb822 form beside the host's others, and its keyring was not trusted on the
strength of the URL it came from: the file is **byte for byte the one that has been signing
production's `cloudflared` since June**, compared by sha256 across the two machines. There is no
`/etc/cloudflared`, no unit and no token, because the tunnel does not exist yet.

**AND IT CANNOT BE CREATED FROM HERE - RE-MEASURED 2026-09-24, unchanged since 2026-09-02.**
`POST /accounts/{acct}/cfd_tunnel` answers `10000 Authentication error` and the tunnel list answers
`success` with **zero** tunnels while production is plainly running one. That second answer is the
dangerous one: a caller that trusts the shape concludes the account has no tunnels. **Creating it
is a dashboard gesture the user makes**, and step 4 of phase 1 waits on it.

#### THE TUNNEL EXISTS NOW, AND IT CANNOT REACH THE EDGE - PORT 7844, MEASURED 2026-09-24

The user made the dashboard gesture the paragraph above waits on, and a connector was installed
**the right way**: the token in a `0600` `EnvironmentFile`, nothing on `ExecStart`, `DynamicUser=yes`
- the defect this repository documented on its own two boxes the same morning, not repeated on a
machine shared with other associations, where it would have handed the tunnel's identity to a dozen
local accounts.

**It cannot connect, and the token is not why.** Measured from the host:

| Probe | Result |
| --- | --- |
| cloudflared's UDP precheck, `region1`/`region2.v2.argotunnel.com` | **FAIL** - `QUIC connection failed` |
| its own automatic fallback to `http2` | taken, then `dial tcp 198.41.200.23:7844: i/o timeout` |
| TCP **443** to that same edge address | **open** |
| TCP **7844** to that same edge address | **blocked** |
| the host's own egress policy | `-P OUTPUT ACCEPT`, and no direct firewalld rule |
| **the same two probes from `canari`, whose tunnel runs** | 443 open and **7844 OPEN** - same command, same edge address |
| TCP 7844 to a SECOND edge address | **blocked**, so it is not one edge host having a bad day |

**The A/B is the whole argument, and it is one command**: production's box reaches 7844 and the
target's does not. Nothing is wrong with cloudflared, the token or the tunnel - the new machine
simply sits behind a network that does not let 7844 out. **The block is UPSTREAM of the machine, on
7844, in BOTH transports.** `http2` is not a way round
it - that mode still dials 7844 and merely swaps UDP for TCP. Cloudflare Tunnel has no port-443
mode, so this would have been a firewall change or nothing.

**AND THE USER TOOK THE OTHER OPTION, so none of that was ever asked for** (section 4, 2026-09-24):
dev and the admin interfaces stay on the old VM, the new host carries production only, and a machine
that needs no tunnel does not care what its network refuses. **The request to the DSI no longer
mentions 7844.** The measurements above are kept because they are true and because the A/B is the
thing a future session would otherwise re-take - not because anything is waiting on them.

#### THE PARADE THAT WAS WRONG, AND WHAT THE BLOCK ACTUALLY BREAKS - 2026-09-24

**READ SECTION 4 BEFORE READING THIS.** The parade below was proposed, and it is REFUTED by a
decision taken with the user on 2026-09-23 and marked not to be relitigated: *public traffic, no
Cloudflare at all*. It is kept here rather than deleted because the reasoning has one half worth
having and one half that shows how a settled decision gets re-opened by accident - by solving the
problem in front of you without re-reading what the problem was allowed to cost.

**AND THE BLOCK IS NOT WHERE THIS PARAGRAPH FIRST PUT IT.** The public path never needed 7844,
because it never needed Cloudflare: nginx on the host, DSI certificates, ufw. What section 4 sends
through a tunnel is the INTERNAL half - the admin interfaces and dev, on `rootz-emse.fr`, behind
Access. **So the refused port does not block phase 2 at all; it blocks the internal door**, and that
is the question that needs an answer, not the public one.

The refuted proposal, for the record: **a tunnel goes OUT of the machine; the proxy comes IN to it**,
and Cloudflare does both.

Replace the tunnel CNAME with an **`A` record to `193.49.175.67`, proxied**. Cloudflare then reaches
the origin on **443 inbound**, the port this host already serves - measured from outside on
2026-09-24: `portail-etu.emse.fr` answers `200`, and a TLS connection carrying a `canari` SNI is
ESTABLISHED and fails only on the certificate, which is the expected half. **Nothing is circumvented
and 7844 is not used at all**, which is the point: inbound 443 to a web server is what this machine
is for.

What it needs, all of it ours:

| Piece | Note |
| --- | --- |
| The DNS record | our zone, no DSI. But `CF_TOKEN_ADMIN` lacks `Zone:DNS` (`10000`, measured 2026-09-24) and the DNS-scoped token is dead - so this is a dashboard gesture or a new token |
| An origin certificate | **Cloudflare Origin CA**: free, issued by Cloudflare, trusted only between the edge and the origin, so `Full (strict)` holds with no ACME and nothing asked of the school |
| A vhost on the host's nginx | already the target shape of section 5; the tunnel was only ever a way of reaching it. **The port allocation table is owed FIRST** - `sites-enabled/canari.conf` currently sends `canari.emse.fr` to Portail-etu |

**AND IT CORRECTS A CLAIM MADE EARLIER THE SAME DAY.** "Without the tunnel phase 1 stops being
reversible" is WRONG for a PROXIED record: a client never resolves the origin address, the edge holds
the mapping, so the rollback is one API call with immediate effect and **no TTL to wait out**. That
is more reversible than a bare DNS flip and level with the tunnel. The bare-record version of this
idea is the one that carries a TTL, and it is not what is proposed here.

The real cost is the honest one: this keeps Cloudflare in the public path, which phase 2 exists to
remove. It is therefore a LANDING, not the target - which is exactly what phase 1 was defined to be.

#### THE OLD ESTATE CAN RELAY WHAT THE NEW ONE CANNOT SEND - MEASURED 2026-09-24, AND NOT NEEDED

**THIS SECTION IS LOAD-BEARING, AND IT WAS DECLARED UNNEEDED FOR HALF A DAY.** The 2026-09-24
decision leaves dev and the admin interfaces on the old VM, and from that it was concluded that
nothing needs to cross - which is wrong, because **the tunnel had a SECOND consumer and it is the
whole of phase 1**. Section 6, step 4, is *"point the tunnel ingress at the new loopback port"*, and
the phase's rollback is *"repoint the tunnel at the old VM"*: every public name in phase 1 reaches
the new host through a tunnel that cannot run on it. **The same error as the parade, one level in**:
a seam was audited through the consumer that had just been discussed, not through all of them, which
is exactly what the durable rule about enumerating consumers exists to prevent.

So a relay is what phase 1 needs, and the question is only which end of the tunnel it sits at:

| | How the new host is reached | What it costs |
| --- | --- | --- |
| **The old VM's web server proxies** (preferred) | the tunnel keeps pointing where it points today; the old VM's nginx gains an upstream to the new host | **NO Cloudflare change at all**, so the dashboard gesture that section 8 calls the one thing blocking phase 1 stops blocking it. Rollback is one line, on a machine we own |
| The tunnel's ingress points at the new host | one ingress rule per name, edited to name the target host instead of a loopback port | **a dashboard gesture, and it cannot be ours**: production's connector runs with `--token` on `ExecStart`, so the tunnel is REMOTELY MANAGED and its ingress lives in Cloudflare, not on the box (measured 2026-09-24) |

Either way the connector stays on the OLD VM, which is what the section-4 decision actually bought:
**nothing is installed on the new host, and nothing there has to reach the edge.**

**AND THE ADDRESS TO POINT AT IS NOT A PRIVATE ONE - THIS IS THE TRAP IN THE OBVIOUS VERSION.** The
two estates are NOT on one LAN. The old VMs sit on a private `/16` and the target host has **only
public addresses** on its single interface; the route from one to the other leaves through the old
VM's gateway and arrives at a public address. What is private is the SOURCE, preserved end to end -
which is what makes a tight allow rule possible, and is the only reason the private range is worth
mentioning at all. So an ingress rule names the target's PUBLIC address, and two consequences
follow: the port must be bound on that public interface rather than on loopback, so it is exposed
to the co-tenants until a rule restricts it to the one source; and the hop between the two estates
is **plain HTTP across the campus network** unless it is carried inside something. An `ssh -L` from
the old VM keeps the service on loopback and encrypts the hop, and pays for it with a key and a
tunnel to supervise - that trade is the whole choice, and it is not a detail of the ingress rule.

The user's proposal, and it is better than the parade above: **do not make the new host reach the
edge - make the old one do it on its behalf.** The refused port is refused on ONE machine, and the
machine that already works sits on the other side of a path we own.

| Measured | Result |
| --- | --- |
| `canari` -> the target host, TCP 22 | **OPEN** |
| `canari` -> the edge, TCP 7844 | **OPEN** (the target host: BLOCKED, measured the same day) |
| The route `canari` takes | through its OWN gateway, out to the host's public address |
| The source address the host SEES | **`canari`'s PRIVATE address, preserved end to end** - no NAT rewrites it |
| Who already relays | `portail-etu-direct` is defined with `ProxyJump canari` - **this relay exists and is used daily** |

The preserved private source is the load-bearing half: it means the target host can pin an allow
rule to ONE address that is not routable from outside the school, rather than opening a port to the
internet. The exact addresses are machine-local and stay in agent memory, not in a PUBLIC repo.

**Two things could be relayed, and they cost differently.** The INTERNAL surface - the admin
interfaces and dev, on `rootz-emse.fr`, behind Access - is what section 4 already routes through a
tunnel and what the 7844 block actually broke; relaying it changes nothing public and keeps
Cloudflare off the new machine, which is what the user asked for. The PUBLIC surface could be
relayed too, but the one reason that made it attractive is GONE - see the section below: the name
already points at the host and already has its certificate, so nothing is owed to the DSI for it -
and it puts Cloudflare back in the public path, which is the decision in section 4. **Re-opening that is a choice to be made out loud, which
is what separates it from the parade above.**

**Two mechanisms for the internal half**, and the difference is who is asked for what:

| | Data path | Costs |
| --- | --- | --- |
| A firewall allow | `cloudflared` on the old box proxies to a port bound on the new host's interface, allowed from the relay's address only | a firewall rule on a machine we do not own; nothing to supervise, no keys |
| An SSH forward | a `systemd` `ssh -N -L` from the old box; services stay loopback-only on the new host | nothing asked of anyone; a key on the old box and a tunnel that can flap |

**And the price, either way, is that the old VM stops being decorative.** Section 4 already keeps it
alive to answer `canari-emse.fr` with 301s; this makes it load-bearing for the internal door, so
retiring it later means doing this again somewhere else. That is a real cost and it is the argument
for asking the DSI once more rather than building the relay.

#### THE NAME ALREADY POINTS AT THE HOST, WITH ITS OWN ADDRESS AND ITS OWN CERTIFICATE - MEASURED 2026-09-24

**Phase 2 owes the DSI nothing for Canari, and a whole class of questions asked here was invented.**
The user said `canari.emse.fr` "ne sera pas reaffecte" and it was read as *we will not be given that
name*; it means *that name is not going to move*. Measured:

| | |
| --- | --- |
| `canari.emse.fr` resolves | to the target host, on **its OWN address** - not the one Portail-etu answers on |
| TLS | a certificate **already issued for `CN=canari.emse.fr`** by the school's CA, valid into 2027 |
| What it serves today | `200`, and the page is **Portail-etu's** |

So the known trap is not a trap and not a collision: `sites-enabled/canari.conf` is simply the wrong
`root` behind the right name, on an address that is already Canari's. **What phase 2 needs is an
nginx vhost, and that is the whole of it** - no DNS record, no certificate request, no name to
negotiate. `cercle.emse.fr` and `miconnect.emse.fr` are the ones that resolve to NOTHING, so those
two are what the DSI request is still for.

**AND THE LESSON IS A READING, NOT A MEASUREMENT.** One French participle was read in the sense that
made the plan harder, and four questions were built on top of it - a new production name, an issuer
change, deep links, two store listings. **A premise that makes the work bigger deserves the probe
FIRST**, and here the probe was one `nslookup` and one `openssl s_client`.

The unit was left INSTALLED and DISABLED for a few hours, then **REMOVED ENTIRELY** once the
2026-09-24 decision made it pointless - unit, `EnvironmentFile`, binary, apt source and keyring, with
the package purged. **Disabling would have been the wrong disposition**: on a machine shared with
other associations, a run token in a file is a liability that a disabled unit keeps alive, and the
configuration worth keeping is the four lines of it written in this page.

**TWO TUNNEL IDENTITIES ARE IN PLAY** - the box carries one, and a second was handed over the same
morning. Nothing was overwritten, because which one is the keeper is a dashboard-side decision and
guessing it is how an orphan tunnel is left claiming a hostname later.

**Nothing of the old estate moved, and that is measured rather than assumed.** All four public names
answered throughout (`cercle`, the apex, `dev`, `auth`) - which is also the proof that no hostname is
bound to the new tunnel: a name pointing at a tunnel with no healthy connector returns a `1033`, and
none did.

**The Portail-etu runner left a personal account.** It ran as one person's login, from that
person's home, on a machine shared with other associations - so closing or renaming that account
would have stopped every deployment of the portal, for a reason nobody would have gone looking for.
It now runs as `gha-runner`: no password, no `sudo`, one group.

| | Path |
| --- | --- |
| Runner installs | `/opt/actions-runner/runners/<repository>/` - one per estate, this is where `cercle`, `canari` and `miconnect` land |
| Deploy directory | `/opt/actions-runner/portail-etu`, which is `~/portail-etu` for that account |
| Unit | `actions.runner.<org>.<name>.service`, `User=gha-runner` |

**The move was blocked by one line, and that line is the lesson.** `deploy.yml` copied from
`~/actions-runner/_work/refonte-portail-etu/refonte-portail-etu`, which encoded the install path,
the owning home and Actions' `_work` layout - three facts about the host written into a file that
should only know about the deploy. It now reads `$GITHUB_WORKSPACE`
([PR 83](https://github.com/emse-students/refonte-portail-etu/pull/83)). **Proven end to end, not
declared**: the egress probe, the one other job that needs `self-hosted`, was dispatched after the
move and came back `success`.

#### `bin` WAS A SYMLINK, AND FOUR DIRECTORIES THAT LOOKED LIKE BACKUPS WERE THE INSTALL

The runner directory held `bin`, `bin.2.336.0`, `bin.2.337.0` and the same for `externals`. The
numbered ones read as leftovers of two self-updates and were deleted as housekeeping. They were not
leftovers: **`bin` and `externals` are symlinks into the newest numbered directory**, which is how
the runner's self-update swaps versions atomically. Deleting them left `svc.sh` reporting `Must run
from runner root or install is corrupt`, with no hint of the cause.

Repaired by re-extracting the official 2.337.0 archive - the same version, sha256 checked against
the release notes - over the directory; `.runner` and `.credentials` are files and survived
untouched, so no re-registration was needed.

**Two rules were already written for this and neither was applied.** A destructive control needs an
allowlist of what it may touch, not a pattern that looks like debris. And a name is not evidence:
`ls -l` before `rm -rf` would have shown the arrow. There is a sharpening, though - **the symlinks
pointed at ABSOLUTE paths under the old home, so the move alone would have broken them.** The
deletion changed a silent breakage into a loud one.

### `cercle` IS READY, AND WHAT IS LEFT IS FOUR GESTURES - 2026-09-24

Steps 1 to 3 of the runbook are done for the first estate. **Nothing serves from the new host and
the old VM has not been touched**: production answered `200` throughout and was re-deployed once,
deliberately, to prove the change below is inert.

| Ready | What was done |
| --- | --- |
| The runner | `cercle-portail`, shell, `run_untagged = false`, locked to the project, **registered PAUSED** so no job can land on it by accident |
| Its version | `gitlab-runner` **19.3.2, the exact version of `gitlab.emse.fr`**. The repository offered 19.4.0; a runner ahead of its server is outside what GitLab supports, and `packages.gitlab.com` is deliberately absent from that host's `unattended-upgrades` origins so nothing raises it on a clock |
| `/srv/le-cercle` | pre-created, owned by `gitlab-runner`. **The deploy job's `mkdir -p` runs as that account and `/srv` belongs to root**, so the first deploy would have died there |
| The two variables | `CERCLE_RUNNER_TAG` and `CERCLE_PUBLISH`, carrying today's values, already through one production deploy |
| The data | restored into `le-cercle_cercle-data` on the target, owned by uid 1000 as the image expects |

**The data rehearsal is a DIFF, not a copy.** `VACUUM INTO` while the application was serving (a
`cp` of a live SQLite file is how a backup ends up subtly corrupt), 106 MB, moved through the
workstation because the two boxes cannot reach each other. Both sides were then inventoried by the
same script: **17 tables, 455722 rows, `user_version = 2`, `integrity_check = ok`** - identical, and
the md5 of the transferred archive matched at both ends. The count that matters is the per-table
one, because a total can agree while two tables have swapped.

#### The cutover, and its rollback, are the same four gestures

The delta re-sync is what makes this a rehearsal rather than the move: the copy above ages from the
moment it is taken.

1. **The tunnel** - a Cloudflare tunnel on the target host with ingress `cercle.canari-emse.fr` ->
   `http://127.0.0.1:5173`. **This is the user's dashboard gesture and the only blocking one.**
2. **The read-only window** - stop the old container, re-run `VACUUM INTO`, move the file, restore
   it into the target volume, diff it again. Nothing about the size suggests this takes minutes.
3. **The flip** - pause `cercle-prod`, un-pause `cercle-portail`, set `CERCLE_RUNNER_TAG` to
   `cercle-portail` and `CERCLE_PUBLISH` to `127.0.0.1:5173`, re-run the pipeline on `main`. It
   builds on the new host, writes the `.env` there from the same CI/CD variables, migrates and
   starts.
4. **The verification** - `/api/health` must answer `{"status":"ok","schema":2}` from the new
   container AND through the public name, and a real sign-in must work. `ORIGIN` does not change in
   phase 1, and the `sessions` table travels with the database, so nobody is signed out.

**The rollback is gestures 3 and 1 reversed**, and it costs nothing because the old VM never stopped
being able to serve: its container is left running and its data is left in place. That is the whole
reason the two host-specific values are variables rather than lines in a commit.

**Two files were NOT removed from the production volume**: `pre-formation-rename.db` and
`pre-reclass.db`, 52 MB each, hand-made snapshots from 2026-08-28 sitting inside the live data
volume. They are archived on the user's workstation and deleting them from production is the user's
call. They do not travel - the move copies the live database only.

### `miconnect` - WHAT THE MOVE MUST CARRY, AND THE RUNBOOK STEP THAT IS EMPTY HERE - 2026-09-24

Measured on the box and in the repository the same day, while preparing the next estate in the
order.

**Step 1 of the runbook does not apply to this estate: NOTHING DEPLOYS IT.** `cercle` needed a
GitLab runner rather than an Actions one; `miconnect` needs neither, because no pipeline has ever
built it. `infrastructure/authentik/README.md` described a `deploy.yml` job copying its compose file
onto the box - **neither that workflow nor that job exists**, and a search for `infrastructure/authentik`
across `.github/` returns nothing. The only `AUTHENTIK_*` secrets the CD still handles are the OIDC
CLIENT's, written into the application's `.env`. So this estate moves by hand, and the repository's
compose file is a REBUILD REFERENCE that had drifted from the running one - including a pinned
`2026.2.2` against a running `2026.8.0`, which is a schema downgrade Authentik's migrations cannot
undo. Both are corrected.

**The stack is one volume and two ports.** `miconnect_database` (declared `external`), and
`9000`/`9443` published on `0.0.0.0` today because the box is its own VM. On the shared host that
is exactly the trap section 2 measured: Docker publishes through the nat table, which firewalld's
zone does not govern, so both must become `127.0.0.1:` there. `data/`, `certs/` and
`custom-templates/` are 16 K, 4 K and 4 K - nothing travels but the database.

**AND THE BACKUP KEY TRAVELS WITH IT.** The nightly backup reaches this box by SSH since 2026-09-24,
with a key whose forced command can do exactly one thing, read the PostgreSQL dump. **On the shared
host the two stacks are co-located again, so `MICONNECT_SSH_HOST` must be EMPTIED** and the local
`docker exec` path resumes. Forgetting it is how the estate spent 93 nights with no Authentik
backup at all - and the difference now is that the script FAILS rather than warns, which is the
entire point of that change ([backup](../../../infrastructure/backup/README.md)).

#### It was STOOD UP on the target host, empty, and taken back down - 2026-09-24

Step 2 of the runbook, with the data left out of it, which is the half that needs no permission and
answers the questions a plan cannot: **the stack runs there, on loopback, inside a tenth of the
memory its VM is sized for.**

| Measured on `193.49.175.67` | |
| --- | --- |
| `http://127.0.0.1:9000/-/health/live/` | `200` |
| `http://193.49.175.67:9000/` from the host itself | **refused** (`000`) |
| Memory, all three containers | **907 MB** (424 server + 300 worker + 183 postgres) against a 2 G VM |
| Startup to healthy | under two minutes, migrations included |

**The loopback binding needs no edit to the compose file** - `COMPOSE_PORT_HTTP=127.0.0.1:9000` in
the `.env` interpolates into the `ports:` entry, and `docker compose config` resolves it to
`host_ip: 127.0.0.1`. That matters because the same file has to keep working on the VM it is leaving.

It was brought down with `down -v`, its throwaway `.env` deleted and its empty volume removed;
`/srv/miconnect/` and its three mount directories stay, ready. **Nothing of the real estate was
touched, and the identity database never left its box.**

**ONE TRAP FOUND BY DOING IT: the container's uid 1000 is `ansible` on this host.** Authentik runs
as `uid=1000(authentik)`, and uid 1000 on the shared machine belongs to the DSI's automation
account - so every file the container writes through a bind mount lands owned by `ansible`, which is
what `./data` and `./certs` looked like after the test. Ownership was put back. **On a shared box a
bind mount is a uid collision waiting to be misread**, and the three directories here are empty
anyway: they are candidates for named volumes at the cutover.

## 7. Phase 2 - the names

`canari-emse.fr` -> `canari.emse.fr`, `cercle.canari-emse.fr` -> `cercle.emse.fr`,
`auth.canari-emse.fr` -> `miconnect.emse.fr`. Dev does not appear: it goes internal.

**Every name costs a DSI ticket - there is no delegated zone and no wildcard**, so they are all
requested at once, together with the two questions the nginx configuration cannot be written
without.

| Ask | Note |
| --- | --- |
| `canari.emse.fr` | **exists, is LIVE and was re-certified 2026-09-22**: `Portail Etudiant ICM` on `193.49.175.122`, a DIFFERENT machine from the one `portail-etu.emse.fr` uses. A reassignment that takes a name off a running site, and the one ask here that can be refused on its merits |
| `cercle.emse.fr` | new. The School reserves `etu.emse.fr` for mail, so it is not `cercle.etu.emse.fr` |
| `miconnect.emse.fr` | new |
| `www.canari.emse.fr` | new, and only so the redirect to the apex exists |
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
Objet : demande d'enregistrements DNS et de certificats pour trois noms (association Canari)

Bonjour,

L'application Canari (association etudiante, actuellement sur canari-emse.fr) et les
services qui l'accompagnent vont etre heberges sur la machine 193.49.175.67, celle qui
sert deja portail-etu.emse.fr. Nous souhaitons a cette occasion passer sous emse.fr.

1. Creation de deux enregistrements A vers 193.49.175.67 :
     cercle.emse.fr
     miconnect.emse.fr
   Et un enregistrement pour www.canari.emse.fr vers la meme adresse que
   canari.emse.fr, celle qui vous paraitra la plus coherente.

2. Aucune demande concernant canari.emse.fr : ce nom pointe deja vers 193.49.175.122,
   qui est une adresse de cette meme machine, et son certificat a ete renouvele le
   22/09/2026. Nous n'avons donc besoin ni d'un nouvel enregistrement, ni d'un nouveau
   certificat pour lui. Nous signalons simplement que ce nom servira desormais Canari :
   il renvoie aujourd'hui le Portail Etudiant ICM, ce qui semble etre une configuration
   nginx restee en place, et nous la corrigerons cote machine.

3. Un certificat par nom pour les trois noms du point 1, livre comme les autres dans
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
| ~~What are the file NAMES inside `/etc/certs/<name>/`?~~ | **ANSWERED 2026-09-24, by that one command** | `cert.pem`, `chain.pem`, `fullchain.pem`, `privkey.pem` - the Let's Encrypt layout - with the key `0600 root:root`, which nginx's root master reads. **`/etc/certs/canari.emse.fr/` ALREADY EXISTS and is complete**: the DSI issued that certificate before any request was made. `handimines.emse.fr` also still has one, for a vhost this cleanup retired |
| ~~Is `193.49.175.122` the same machine as `193.49.175.67`?~~ | **ANSWERED 2026-09-24: yes, measured** | `ens18` carries `.67`, `.40` and `.122`. Section 2 |
| ~~What of the shared box's legacy is ours to clean?~~ | **ANSWERED 2026-09-24 by the user, and DONE** | The nine php-fpm versions, apache2, phpMyAdmin and MySQL are gone; the databases are archived rather than destroyed. What was NOT touched is named above: `wazuh-agent` stays at 4.14.7 because an agent newer than the DSI's manager on `193.49.175.93` is unsupported, `isc-dhcp-client` stays because this machine is reached only over SSH, and the other associations' web roots under `/export/www` are untouched |
| Production's Postgres volume size | one command on `canari` | the read-only window is quoted from it |
| Does Portail-etu become a compose project with a declared `name:` and ceilings like the others? | user | it is the only estate that would not, and the standing mandate is homogeneity everywhere |
| What was `zookeeper` for, and why is Authentik's database volume on Canari's VM? | nobody has asked | both are dropped by not being recreated, unless one of them turns out to matter |
| What becomes of the Proxmox host once every VM is off it | user, not yet decided | it is the obvious destination for the reworked backups |
