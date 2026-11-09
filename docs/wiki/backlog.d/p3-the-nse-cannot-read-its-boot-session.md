## P3 - the NSE's boot proof: replaced by the continuous uptime, one reading owed

The extension's sandbox refuses `kern.bootsessionuuid` (`EPERM`, iPhone 12, `v1.6.5-alpha.2`), so the
boot proof never ran and every cold launch logged the refusal. Since 2026-11-06 each marker carries
`up` (`mach_continuous_time`), and the app's reader, reading its own uptime after every marker, calls
a marker stamped AHEAD of it another boot's: an uptime never goes back within a boot. A one-sided
proof - an earlier boot's marker stamped below the reading is left to `kill(pid, 0)` and the marker
cap. Both twins of the old sysctl are deleted
([mobile](../frontend/mobile.md#what-the-extension-did-in-the-apps-log-2026-11-01)).

**Owed on the iPhone 12, on any build `>= 1.6.6-alpha.2`:** rows R3a (no sandbox refusal) and R3b
(a marker from before a reboot) of
[device-verification](../device-verification.md#ios-3075-the-ios-follow-ups-of-3075---owed-on-the-iphone-12);
R3b decides whether the one-sided proof is enough. Closes when read.
