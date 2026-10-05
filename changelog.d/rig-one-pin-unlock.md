### Changed - the rig unlocks a PIN through one implementation

The two archived runners that still carried their own `pin.mjs` wrapper (`notif7.mjs`, `tab236.mjs`) now call `pinspawn.mjs`, like `phone.mjs` and the iPhone module ([rig README](tools/cross-client-harness/README.md)).
