## P1 - The iOS app aborted whenever its accessibility tree was read: the fix shipped in `v1.3.0` (#2101), owed its confirmation (iPhone 12, 2026-10-19)

Any WDA query killed `1.3.0-alpha.1` and `-alpha.2` within ~10 ms (`abort() called`), where `1.2.9`
survived; VoiceOver users would hit the same path. The crash reports (`pymobiledevice3 crash pull`)
read a FREED responder at the end of the chain that ends at the app delegate; the prime candidate was
#2000's `CanariReassignAppDelegate`, which kept the delegate in a local. The fix keeps it in a static
strong reference (#2101, in `v1.3.0`; the full reading is in that pull request). **Owed, on a build
since `v1.3.0`:** (1) a WDA tree/element query no longer aborts; (2) `[CanariPush] APNs token received`
appears in the syslog after `registerForRemoteNotifications`; (3) the becoming-active line reads `the
kept-alive one`. If (1) still aborts, the next candidate is the reassignment ITSELF - drop it. The
silent-frame reading below waits on this one.
