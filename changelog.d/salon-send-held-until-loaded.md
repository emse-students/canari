### Fixed - a salon message sent before its salon is loaded waits for it instead of being refused

The row stays pending and goes, sealed and signed, once the community listing enters the salon. It turns failed with Retry only if the salon cannot load. The send banner is now opaque and sits in the composer instead of over the thread ([chat](docs/wiki/frontend/modules/chat.md#a-salon-not-yet-loaded-holds-the-send-it-does-not-refuse-it-2026-10-13)).
