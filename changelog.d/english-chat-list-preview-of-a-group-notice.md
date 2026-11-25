### Fixed - the chat list previews a member addition in the reader's language

Every preview of a "X added Y to the group" row (and rename, leave, removal) was the sentence stored in the writer's language, so the English list read French. Every caller (list, reply, search, notification) now draws it from the ids the row carries through the shared name cache, as the bubble already did, in the language of the app; a name not resolved yet keeps the stored sentence and is logged ([history-reconciliation](docs/wiki/protocols/history-reconciliation.md)).
