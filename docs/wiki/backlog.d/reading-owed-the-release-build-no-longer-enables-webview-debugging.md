## Reading owed - the release build no longer enables WebView debugging

target: 1.7.0

**What is built:** the release build no longer enables WebView debugging

**The reading that closes it:** HARDWARE, NOT the Mi 9T (its `userdebug` ROM makes every WebView inspectable): the `/proc/net/unix` probe on a `user`-build device ([check R](../device-verification.md#r-the-shrunk-release-apk-actually-runs---owed-on-android))
