### Changed - a pre-release iPhone should keep its microphone in a call when locked or backgrounded (unproven until its hardware reading), and the other side is told when a phone takes its microphone

Pre-release iPhone builds declare the `audio` background mode WKWebView needs to keep a hidden page's microphone, and a new `MicSuspended` relay frame shows the partner why the voice stopped ([calls](docs/wiki/frontend/modules/calls.md#wp-c-bg-i---the-iphones-microphone-in-the-background-2026-10-20)).
