### Fixed - the carte editor no longer saves on open, and a publish waits for the save it promised

Opening a poster wrote it back 4 s later, which could persist a random silhouette for a new
association; a publish could overtake a save in flight and put online a state no reopen could
reproduce; and the green "En ligne" control looked like a status while one click took the map off
the portail. It is now a status with a separate confirmed action
([carte-vie-asso](docs/wiki/carte-vie-asso.md#opening-a-project-is-not-editing-it-and-being-live-is-not-a-button)).
