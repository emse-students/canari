# Host OS updates

**The chain that keeps dependencies current used to stop at the repository.** Dependabot, the
auto-merge and the ceiling all reason about `package.json` and `Cargo.toml`; nothing reasoned about
the DEBIAN PACKAGES on the four boxes those services run on, and on 2026-09-02 the production origin
had drifted **113 packages behind, 50 of them from `stable-security`**. It was taken to 0 by hand
that day, which installed no mechanism and so retired nothing.

This page is the mechanism and its report, installed 2026-09-03 on the user's decision
(*"unattended-upgrades securite + rapport"*).

## The estate, and what each box was found doing

| Host | Debian | Reached as | Found |
|---|---|---|---|
| `canari` (10.0.0.3) | 13 trixie | `canari`, `sudo` + `docker` | no `unattended-upgrades`, no `20auto-upgrades` |
| `mitv` (10.0.0.4) | 12 bookworm | **root** | **switches ON, package ABSENT**; reboot pending since 12 July |
| `cercle` (10.0.0.6) | 13 trixie | `cercle`, passwordless `sudo` | no `unattended-upgrades`, 17 packages behind |
| `miconnect` (10.0.0.7) | 13 trixie | `miconnect`, `sudo` | no `unattended-upgrades` |

**`mitv` is the row worth reading twice.** It carried
`/etc/apt/apt.conf.d/20auto-upgrades` with `APT::Periodic::Unattended-Upgrade "1"` and the package
not installed - a configuration that reads as "on" and does nothing at all. And
`apt-daily-upgrade.timer` answered `enabled` on **all four** hosts while not one of them had
anything to do the upgrading. Anyone auditing this estate by listing timers would have concluded
packages were being kept current.

## The policy: security origins only, and nothing reboots

`/etc/apt/apt.conf.d/52canari-unattended-upgrades` on every host. Three of its lines are decisions.

**`#clear` comes first, and without it the file is decorative.** An APT configuration LIST
ACCUMULATES across files - it does not override - so declaring `Unattended-Upgrade::Origins-Pattern`
APPENDS to whatever `50unattended-upgrades` already allows. Measured on `cercle` before the clear
was added, the resolved list opened with `origin=Debian,codename=trixie,label=Debian`: **the whole
of stable**, which is the opposite of what was asked for. And the two Debian releases here do not
agree - bookworm ships that entry commented out, trixie does not - so a config that looked correct
on `mitv` was wrong on the three trixie boxes.

```
#clear "Unattended-Upgrade::Origins-Pattern";
#clear "Unattended-Upgrade::Package-Blacklist";

Unattended-Upgrade::Origins-Pattern {
        "origin=Debian,codename=${distro_codename}-security,label=Debian-Security";
        "origin=Debian,codename=${distro_codename},label=Debian-Security";
};
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "false";
Unattended-Upgrade::SyslogEnable "true";
```

**Security only, because the risk is asymmetric.** A security update is the one class where doing
nothing is the larger risk; everything else stays a decision. `-updates` is deliberately absent -
that is where a PostgreSQL major would arrive, and PG 15 is held at 15 on purpose because 18 needs a
migration nobody has performed (33 minutes of production down on 2026-09-01).

**Nothing reboots, and no kernel is removed.** Reclaiming boot space is not worth a box that cannot
boot the kernel it was tested on, and a reboot arriving unannounced at night is not a trade this
estate accepts.

### The 30-second `502` this policy does NOT incur, with the evidence

[backlog](../backlog.md) priced the honest cost of unattended upgrades here before they were
installed: *an apt upgrade on this box restarts the Docker daemon (12 `docker`/`containerd` packages
were in the manual set), which restarts all 23 containers at once and gave a ~30-second window of
`502` on the public site.*

**Security-only scope removes that**, and it was verified rather than assumed. `unattended-upgrade
--dry-run --debug` on `cercle`, which had 22 packages pending including Docker CE:

```
Marking not allowed <apt_pkg.PackageFile ... o=Docker,l=Docker CE site='download.docker.com'> with -32768 pin
Packages that will be upgraded: bsdextrautils bsdutils fdisk libblkid1 libexpat1 libfdisk1
  liblastlog2-2 libmount1 libsmartcols1 libssl3t64 libuuid1 login mount openssl
  openssl-provider-legacy postfix unzip util-linux util-linux-extra zip
```

The Docker CE origin is pinned to `-32768` - *"Marking not allowed"* - so `containerd.io` and the
Docker plugins are checked and refused. **Docker is upgraded only when a human decides to**, which
is what the backlog asked for.

### A limit this does not fix, stated so it is not mistaken for solved

`openssl` and `libssl3t64` in that list are *installed*, not *in effect*: Debian's
`unattended-upgrades` restarts no services, so every long-running process keeps the old library
mapped until something restarts it. A library security fix that nothing has restarted into is the
same shape as the pending reboot on `mitv`, one layer down. Nothing here measures it.

## The report, and why a red workflow run is the channel

**A correct mechanism with no report is found by hand, a day late** - the rule this whole page
exists under. `.github/workflows/host-updates.yml` runs
`infrastructure/deploy/host-update-report.sh` daily on the self-hosted runner and FAILS the run on
any finding. There is no alerting anywhere in this estate (both outages of 2026-09-01 were reported
by the user), and what this repository does read is `gh run list` - so a failing run is the only
channel that already exists.

**It reports the box it RUNS ON, which is production, and that scope is a measurement not a
choice.** The runner's `canari` key is authorised on none of the other three hosts, and installing
cross-host keys in order to write a report is a privilege expansion nobody asked for. The gap is in
[backlog](../backlog.md) with what would close it.

### What it distinguishes, because "0 pending" has several causes

| reading | what it could mean |
|---|---|
| 0 pending, timer fired, log clean | working |
| 0 pending, timer **never** fired | nothing is applying anything - the count is stale, not good |
| N pending, timer fired | it runs and REFUSES: a held package, or a failed run |
| 0 pending, reboot required | applied, and not in effect |
| 0 pending, origins widened | applying MORE than security, which is a different risk |

So the script reads the timer's last TRIGGER, the last log outcome and the resolved origin list, and
never a pending count alone. **It asks whether the timer RAN, never whether it is enabled** -
`is-enabled` said `enabled` on four hosts that were applying nothing, which is the same rule this
repository already holds about GitHub's cron: a schedule is a request, and its failure mode is not
lateness, it is ABSENCE.

### Two defects the report had, both found by running it rather than reading it

**It invented a finding.** `gather` wrote its facts unquoted, and `judge` reads them with `.` - so
`origins=a|b` was parsed as a PIPELINE, not an assignment. The variable came out unset, nothing
errored, and the report announced `allowed origins: NONE` on a host whose policy was perfectly
correct. Every value is `%q`-quoted now.

**And it was blind where it mattered most.** `/var/log/unattended-upgrades` is `root:adm 0750` and
the runner account was not in `adm`, so the outcome came back `never` on a box whose run had
finished four hours earlier - the ERROR arm could not have fired whatever the host did. The account
was added to `adm`, which grants nothing an account already in `sudo` and `docker` did not have, and
**an unreadable log is now a FINDING** rather than silence, so losing the group again says so.

Both are asserted in `.github/scripts/tests/host-update-report.test.sh` (17 assertions), which is
why `gather` and `judge` are separate functions: the judgement runs against fabricated hosts, and
every case in it is a shape really met on 2026-09-03 - `mitv`'s switch-on-package-absent, its
kernel reboot, the four enabled-but-idle timers, and the accumulated `label=Debian`.

## See also

- [backlog](../backlog.md) - what stays open: the other three hosts' reporter, and the library
  restart question
- [cloudflare-edge](cloudflare-edge.md#nothing-keeps-the-daemon-current-and-a-dormant-timer-says-otherwise) -
  `cloudflared` is NOT covered by this and enabling its own timer would be wrong for a separate
  reason
- [docker](docker.md#the-deploy-account-is-root-on-the-host-by-way-of-the-docker-group) - why `adm`
  grants this account nothing new
