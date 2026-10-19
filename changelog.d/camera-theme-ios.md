### Fixed - opening the camera no longer turns the iOS app dark

The camera's light status-bar icons set the iOS window's style, and the theme store took the echo for the phone switching to dark, then kept it after the camera closed; it now ignores its own echo ([reels](docs/wiki/frontend/modules/reels.md#the-tab-c5)).
