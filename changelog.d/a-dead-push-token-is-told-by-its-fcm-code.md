### Fixed - a call ring drops a dead push token, read from the FCM error code

The ring path decided on the error's text, which a real Firebase error never carries, and dropped a token on any `invalid-argument`; one classifier now reads the structured code for every push ([chat-delivery](docs/wiki/services/chat-delivery.md#priority-notifications---calls--mentions-wp-xp-5)).

A token FCM calls malformed (`invalid-argument`, also a bad payload's answer) is kept: measured on production (32 h of reachable log, 1195 sends), zero such failures; every FCM failure line now names its `code=`, which is what would reveal one. A refused credential (`mismatched-credential` and its two siblings) logs at ERROR as our own misconfiguration.
