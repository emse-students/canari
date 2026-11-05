### Fixed - a file saved on Android into "Downloads" was listed as 0 bytes, and refused when shared from there

The save dialog's document is now written through the provider's own stream, closed after the copy, instead of a detached descriptor the provider saw closed before the first byte; the in-app log export was the reported case ([mobile](docs/wiki/frontend/mobile.md)).
