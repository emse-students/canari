### Fixed - the `ChatArea.entryWindow` unit test no longer fails when a loaded runner freezes its worker

The file takes the same load-bound test deadline as the other starved-worker victims; the asserted counts are unchanged ([test-suite-reform](docs/wiki/test-suite-reform.md)).
