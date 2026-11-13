## The iOS rig adapter (#1284-#1286, #1290, #1291, #1303): no board row has a verdict on the iPhone yet

target: 1.10.0

**What is built:** the iOS rig adapter (#1284-#1286, #1290, #1291, #1303)

**The reading that closes it:** **NO board row has a verdict on the iPhone yet**: each row needs its mechanical port; O3 and O6-O11 change phone state (airplane mode, force quit, reboot, reinstall) and wait for a dedicated session; the Return key was never pressed; `pymobiledevice3` is on no PATH (the env var `PYMOBILEDEVICE3` points to it). Order: [cross-client-ios](../cross-client-ios.md#what-is-owed)
