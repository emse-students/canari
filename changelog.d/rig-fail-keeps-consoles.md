### Changed - a row that does not PASS keeps every client's whole console

A FAIL used to record only lines a classifier picked out, and nothing for a clean client, so DUP-6 on `1.4.1-alpha.4` could not show where its side message waited. A non-PASS row now writes each observed client's console to the rig's state directory and names the files in its record ([cross-client-campaign-1-4-1](docs/wiki/cross-client-campaign-1-4-1.md)).
