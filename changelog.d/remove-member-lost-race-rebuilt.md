### Fixed - a member Remove that loses the commit race is rebuilt, or the person who asked is told

A refused Remove is staged again on the epoch that beat it, and a removal recorded but not committed now says so on screen instead of in a log line ([history-reconciliation](docs/wiki/protocols/history-reconciliation.md)).
