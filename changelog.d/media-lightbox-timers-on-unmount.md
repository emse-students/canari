### Fixed - the media viewer clears its tap and zoom timers when it is unmounted

A tap timer outliving the viewer logged after its test file ended and failed the frontend CI run with every test green ([architecture](docs/wiki/frontend/architecture.md#a-timer-a-component-starts-dies-with-the-component-not-only-with-its-closed-state)).
