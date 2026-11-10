### Fixed - a "joined" / "added" row no longer stays "Utilisateur inconnu" when the newcomer's name arrives late

A membership or group notice row now carries the ids it names and the reader draws the names from the one display-name source, fetching an unknown one, instead of a sentence frozen at write time. Rows written before this keep their stored sentence. See [history-reconciliation](docs/wiki/protocols/history-reconciliation.md#the-acting-device-writes-its-own-notice).
