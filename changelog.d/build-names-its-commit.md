### Fixed - a build names its own commit

The frontend build version is now `<builtAtMs>-<sha>`, and the test rig reads the commit off the bundle instead of inferring it from a clock ([testing-methodology](docs/wiki/testing-methodology.md)).
