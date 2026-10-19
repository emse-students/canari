### Added - a call-audio fidelity rig, and a call log that names the side handing the decoder non-Opus bytes

`tools/call-audio-fidelity` measures what a call does to a known sound between two Chromes; it puts the phones' "formless noise" on bytes that are not Opus reaching the decoder, never on the app's Chromium path. The E2E worker now logs which side first holds such a payload, and proves a double encryption ([calls](docs/wiki/frontend/modules/calls.md#audio-quality-measured-2026-10-19)).
