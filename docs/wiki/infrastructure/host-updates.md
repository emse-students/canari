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
exists under. `.github/workflows/scheduled.yml` runs
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

### ADDING THE GROUP IS NOT ENOUGH - THE RUNNER HAS TO BE RESTARTED, and the report proved it

**A process holds the group set it was started with.** `adduser canari adm` returned success,
`id -Gn canari` listed `adm` immediately, and the very next workflow run still reported
`last log outcome: unreadable` - because the Actions runner had been running since long before, and
`/proc/<pid>/status` showed `Groups: 27 100 991 1000` with no `4`. A fresh `ssh` session had the
group and the service did not.

`sudo systemctl restart actions.runner.emse-students-canari.Canari.service` fixed it
(`Groups: 4 27 100 991 1000` after), and the run went green. **Restart it only while no job is in
flight** - it is the same runner every deploy uses.

**This is the best thing that happened to this report.** It was *proved able to fail against the
real production box*, not only against fabricated facts: one run red because it could not see, the
next green because it could, nothing else about the host having changed. A report whose red state
has never been observed is a report nobody should believe - and the failure it produced was the
honest one, naming its own blindness rather than announcing health.

## The 7.3 TB RAID1 nobody was watching, found while rebooting for the kernel (2026-09-03)

`mitv` was owed a reboot for `linux-image-6.12.95+deb12-amd64` since 12 July, and taking it (57
days of uptime, back in 75 seconds, `reboot-required` now clear) exposed something the kernel had
nothing to do with. **`mdmonitor.service` had been FAILED on every boot back to at least 9 June**,
and the box carries a live mirror of 7.3 TB - `md0 : active raid1 sdb[2] sdc[0]`, `[2/2] [UU]` -
holding all of the NAS storage: Immich's library, the Samba shares, MiGallery's and Sky's data.

The reason was `mdadm: No mail address or alert command - not monitoring`, then exit 1. **The
monitor refused to start at all.** A disk failing would have left the array running degraded on one
disk with NOTHING recording it - not locally, not anywhere - until the second one went and the
7.3 TB with it.

### `MAILADDR` would have been the wrong fix, and why is the whole point

postfix and exim4 are both inactive on that box, and `monit` - which DOES run, and does watch the
root filesystem, the data mount and nginx - has no `set alert` and no `set mailserver` destination
at all. **There is no notification channel on this host.** An address in `mdadm.conf` would have
made the unit start and delivered its warnings into a spool nobody opens: the unit would then read
*healthy* while a degraded array stayed silent, which is strictly worse than the failure it
replaced. That is this page's own rule turned on itself - a check that cannot reach its reader
reports health.

So the event goes to syslog, via `PROGRAM /usr/local/sbin/mdadm-alert`, **with severity by event
class**: `Fail`, `FailSpare`, `DegradedArray` and `DeviceDisappeared` at `daemon.crit`, everything
else at `daemon.notice`. A level that cries wolf on `RebuildFinished` is a level its reader learns
to skip, and the line it then skips is the one that mattered.

**It was proved by firing it rather than by reading it.** `mdadm --monitor --scan --test --oneshot`
put a `TestMessage` line into syslog with the `mdstat` snapshot beside it, which is the same
discipline the update report earned the hard way: a check whose alarm has never been observed is a
check nobody should believe.

### Which immediately caught a second thing - the alarm that would have cried wolf for ever

`SparesMissing on /dev/md0` fired on the RESTART itself, not on the test. `mdadm.conf` declared
`spares=1`, and the box has three disks: `sda` for the OS, `sdb` and `sdc` in the mirror, and no
spare anywhere. The declaration was stale, so it was removed - `mdmonitor` now restarts with no
lines at all, and **a future `SparesMissing` therefore means something**. Left alone it would have
alarmed on every boot, and a monitor installed on Thursday and ignored by Friday is not a monitor.

### `dnsmasq`, the other failed unit, was not useful

Zero queries ever logged, nothing listening on 53, dead since at least June while the box resolved
perfectly. It failed on a BOOT RACE - `bind-interfaces` with `listen-address=10.0.0.4` evaluated
before the interface carried that address - so `bind-dynamic` is the fix if a LAN DNS cache is ever
actually wanted. It is disabled instead, and `systemctl enable --now dnsmasq` reverts that.

### What this does NOT install is a report

Syslog on `mitv` is read by nobody and nothing. **The array now has a SENSOR and still has no
CHANNEL**, which is the same gap already open for the three hosts the update report cannot reach,
one subject wider. It is in [backlog](../backlog.md) with what closes it: `/proc/mdstat` read into
the same daily report, and that report reaching more than the production box.

## See also

- [backlog](../backlog.md) - what stays open: the other three hosts' reporter, and the library
  restart question
- [cloudflare-edge](cloudflare-edge.md#nothing-keeps-the-daemon-current-and-a-dormant-timer-says-otherwise) -
  `cloudflared` is NOT covered by this and enabling its own timer would be wrong for a separate
  reason
- [docker](docker.md#the-deploy-account-is-root-on-the-host-by-way-of-the-docker-group) - why `adm`
  grants this account nothing new
