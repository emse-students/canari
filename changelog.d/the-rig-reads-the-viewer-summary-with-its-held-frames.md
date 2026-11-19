### Fixed - the test rig reads the viewer's summary line again since it counts held last frames

#3862 added `N last frames held` to the live viewer's summary line; the rig's line table (`liverows.mjs`) and the harness self-test still expected the earlier form, so a reading would have counted the line as dirt and `Test Harness (self-tests)` failed on any branch that ran it. Both forms are now read ([live](docs/wiki/frontend/modules/live.md#audio-drifts-ahead-of-the-video-under-15-fps-2026-11-19)).
