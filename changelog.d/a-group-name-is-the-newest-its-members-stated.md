### Fixed - a group's name is the newest one its members stated, not the last rename a device read

An older rename read after a newer one (a queue drain, a replay page) put the old name back. Each name
is now dated by the server's acceptance of its frame, a newcomer is handed it by the join push, and the
server's list no longer overrides a dated name. A rename whose send got no answer is kept and re-sent,
never reported as failed - the first step of taking names off the server
([sealed-names](docs/wiki/protocols/sealed-names.md)).
