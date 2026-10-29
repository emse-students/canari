### Fixed - a live viewer's stall that fired while a segment was downloading was forgotten

The poll now reads the stall after its downloads and clears it only by the re-anchor it asks for, so the viewer no longer stalls again seconds later; each delivery also logs what it did to the buffer ([live](docs/wiki/frontend/modules/live.md#the-buffer-policy-l-f1-2026-10-27)).
