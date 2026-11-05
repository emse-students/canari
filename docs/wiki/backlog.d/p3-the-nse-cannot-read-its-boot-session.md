## P3 - the NSE cannot read `kern.bootsessionuuid`, so its boot proof never runs and every cold launch says so

Read on the bench iPhone 12 (`v1.6.5-alpha.2`, 2026-11-05, over `pymobiledevice3 syslog live`): every
cold launch of the extension logs `[CanariNSE] outcome: kern.bootsessionuuid unreadable errno=1`.
`errno=1` is `EPERM`, so this is not a transient kernel answer. The extension's sandbox refuses this
sysctl, and `bootSession` (`NotificationService.swift`, about line 648) is therefore nil in EVERY run.

Two consequences:

- **The line is noise.** It repeats a fixed fact at every launch.
- **The mechanism is dead in the NSE.** A marker left by a run that died with an earlier boot can never
  be told apart from a live run by the boot proof. Only the pid check is left.

The fix is not to demote the line. Instead:

1. Find a boot identity the sandbox allows. Candidates are `kern.boottime` read together with a
   monotonic clock (`mach_continuous_time`), or a value the main app stamps into the App Group at
   each launch.
2. Or show that the pid check alone answers the question, and delete the boot proof from both twins:
   this one and `boot_session` in `commands/nse_outcomes.rs`.

The Rust twin runs in the main app, where the sysctl may be allowed. Read it there before choosing.
