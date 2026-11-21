## P3 - Android: `ReadElsewhereMarks.forgetAll` and `GenericBannerLedger.allCleared` have no caller since the foreground sweep went (2026-11-21)

target: 1.8.0

The app's coming to the front stopped clearing conversation banners (owner, 2026-11-21), which was the
only caller of both, with the `allWithdrawn` and `reactionsSwept` states `forgetAll` sets and their
Kotlin tests (`ReadElsewhereMarksTest`, `GenericBannerLedgerTest`). Delete them together: the states
are read in `ReadElsewhereMarks` (`bannerOf`, the reaction base), so removing the function means
reasoning about each read - which could not be compiled or run here. Until then the dead code is
inert: the flags it sets are never set.
