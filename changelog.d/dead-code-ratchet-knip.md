### Changed - dead code is measured in CI and may only go down

`knip` and an unused-translation-key scan run on every frontend pull request against a baseline, the first sweep deletes the unused deprecated `PostImage` component and 79 translation keys no source names ([dead-code](docs/wiki/dead-code.md)).
