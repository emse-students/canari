### Fixed - a row listed again by a pull issued before its ack is no longer accused at launch

The boot's second pull listed rows the first pull's drain had not acknowledged yet, and the repeat
was accused as an ack the server forgot (`[QUEUE] delivery ... arrived twice`, twice per launch on the
Mi 9T); the line now carries which came first, and still accuses an ack that landed before the pull
([chat](docs/wiki/frontend/modules/chat.md#a-done-row-listed-again-whose-ack-came-first-2026-11-04)).
