### Fixed - a phone that signed out and came back by fingerprint or Face ID showed only "Nouveau message de ..." for every push

A sign-out strips `push_context.json` to its identity, and only a PIN sign-in wrote it back; every sign-in now writes it, and the Android readers say `absent` or `invalid: <field> missing` instead of one line for both ([content-free-push](docs/wiki/protocols/content-free-push.md#who-writes-push_contextjson-and-when-2026-11-07)).
