### Changed - the "server unreachable" line says what proved it

A link declared unreachable by two request deadlines now prints `(2 request deadlines in a row)`, and a refused socket `(transport failure: <error type>)`, instead of the same sentence for both ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md)).
