### Fixed - The Android release build no longer fails on a French apostrophe in `strings.xml`

The booking-removed notification strings (#2945) carried bare apostrophes, which aapt2 refuses at `:app:mergeUniversalReleaseResources`, so the `1.6.3-alpha.3` Play build failed. They are escaped, and `nativeStrings.test.ts` now rejects an unescaped quote or a malformed unicode escape in every Android `strings.xml`.
