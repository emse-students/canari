## P3 - Android `E/AppOps: attributionTag not declared in manifest of fr.emse.canari`, about 20 times an hour (S17, 2026-11-20)

target: 1.8.7

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

Read on the Mi 9T, sitting S17 of 2026-11-20 (first seen as 24 lines in an earlier reading, [device-verification](../device-verification.md)): the system logs `attributionTag not declared in manifest of fr.emse.canari` about 20 times an hour. Some call passes an attribution tag that the manifest does not declare. Find the call, then either declare the tag in the manifest or stop passing it. Verify by an hour of logcat with no such line.
