### Fixed - a message sent while production deploys waits for the server instead of failing

A `502`, `503` or `504` is now typed at the throw as "not now" and is never a refusal: a DM or group text is held on the plain retry ladder and resumed by a reconnect (it used to count toward the five 5xx that show "Echec"), a salon text is held and re-sent under its client id instead of turning "non confirme", and the bubble says "En attente du serveur" meanwhile ([chat](docs/wiki/frontend/modules/chat.md#a-deploys-not-now-is-not-a-send-failure-r05-2026-11-09)).
