### Fixed - the App Store submission waits for its screenshots to finish processing

The `v1.6.9` stable was refused by Apple with `Asset is being processed` because screenshots had been replaced an hour before; `tools/app-store/submit.mjs` now waits on each asset's delivery state like it waits on the build, and refuses one that can never finish ([app-store](tools/app-store/README.md)).
