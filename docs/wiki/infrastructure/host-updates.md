# Host OS updates

**The per-host table, the findings per box and the operating notes are kept in the operators'
private notes**: they map which machines run what and where updates are missing, which is an access
map. The mechanism and the rules that bind code stay here.

The chain that keeps dependencies current used to stop at the repository: Dependabot, the auto-merge
and the ceiling all reason about `package.json` and `Cargo.toml`, and nothing reasoned about the Debian
packages on the hosts those services run on. The mechanism was installed 2026-09-03 on the user's
decision (*"unattended-upgrades securite + rapport"*).

## The policy: security origins only, and nothing reboots

`/etc/apt/apt.conf.d/52canari-unattended-upgrades`. Three of its lines are decisions.

**`#clear` comes first, and without it the file is decorative.** An APT configuration LIST
ACCUMULATES across files, so declaring `Unattended-Upgrade::Origins-Pattern` APPENDS to whatever
`50unattended-upgrades` already allows; measured, the resolved list opened with the whole of stable.
The two Debian releases do not agree on the defaults, so a config that looked right on one was wrong
on the other.

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

Security only, because the risk is asymmetric: doing nothing about a security update is the larger
risk, everything else (`-updates`, where a PostgreSQL major would arrive) stays a decision. Nothing
reboots and no kernel is removed.

## The report, and why a red workflow run is the channel

**A correct mechanism with no report is found by hand, a day late.** `.github/workflows/scheduled.yml`
runs `infrastructure/deploy/host-update-report.sh` daily on the self-hosted runner and FAILS the run
on any finding; nothing else in this estate alerts, and a failing run is the channel that exists. It
reports the host it RUNS ON. It never reads a pending count alone: it reads whether the timer RAN
(`is-enabled` says nothing), the last log outcome and the resolved origin list. A switch that reads
"on" with the package absent is a finding.

## The 7.3 TB RAID1 nobody was watching, found while rebooting for the kernel (2026-09-03)

A software-RAID monitor had refused to start on every boot because no alert destination was
configured. **Rule: an alert address in a host with no mail transport is worse than no alert (the
unit reads healthy while the spool is unread); route the event to syslog with severity by event
class instead, and prove the alarm by firing a test event through the real path.** A stale
`spares=` declaration would have cried wolf on every boot and was removed.

## The root disk

**The host's administrators found its root disk at 90 % on 2026-10-24** (92 % when read) and asked
for no new container until they extend it; nothing here had said so. Since then the same report
(`host-update-report.sh`, the `hosts` job of `scheduled.yml`, daily) prints the root filesystem's
percentage and the three consumers that are OURS, and **turns the run red at `DISK_FAIL_PERCENT`
(85)**:

| Line | Read from | Note |
| --- | --- | --- |
| root filesystem | `df -P -k /` | the finding; an unreadable `df` is a finding too |
| backups | `du -sk` of the `BACKUP_DIR` the runner account's crontab sets | archives and the local restic repository ([backup](backup.md#retention)) |
| docker | `docker system df` | the WHOLE daemon, co-tenants included; images are pruned by [docker-prune](../../../infrastructure/docker-prune/README.md) |
| runner leftovers | every runner beside the one running the job, from `RUNNER_WORKSPACE` | a NOTE, never a finding |

The threshold is pinned by `host-update-report.test.sh` (85 fails, 84 passes, the variable moves
it, an unreadable `df` fails).

### The cleanup of 2026-10-24, and what is safe to delete

Done by hand with the owner's yes, 92 % to 73 %:

1. **Old runner versions, -5.2 GB over the four self-hosted runners.** A runner updates itself: it
   downloads into `_work/_update`, unpacks `bin.<new>` and `externals.<new>` beside the old ones,
   moves the `bin` and `externals` SYMLINKS, and never deletes the old pair. **Safe:** a `bin.<v>`
   or `externals.<v>` directory that the `bin` / `externals` symlink does NOT point to (read it with
   `readlink`), and the contents of `_work/_update`. **Not safe:** the directory a symlink names, the
   symlinks, the runner's own configuration files (`.runner`, `.credentials*`), `_work/<repo>` while
   a job runs, and `_diag` (the runner's logs, small).
2. **Local nightly archives older than 7 days**, after checking the offsite copy held the same
   files; [backup](backup.md#retention) made 7 days the rule.

**It comes back.** Every runner release leaves one more pair per runner (the last one reached three
runners on 2026-10-22 and the fourth on 2026-10-24); the four held 5.2 GB of leftovers that day. The
report names them with
their size; deleting them stays a hand's work, because the runners' home is a directory of the
shared host and a cron there is a change its administrators have not agreed to.

## What stays open: the report's reach, the RAID channel, and libraries nothing restarts

The report covers only the host the runner lives on; a RAID sensor without a report channel and a
library security fix that is installed but not in effect remain open. See
[backlog](../backlog.md#p2---two-of-the-hosts-that-take-security-updates-are-not-reported-on-and-a-library-nothing-restarts-the-rest-closed-2026-09-03).
The shared host's own update policy is the school's and is judged on our questions only.
