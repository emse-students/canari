### Security - a history answer is sealed to the device that asked for it

Every history ask now carries a key minted for it, and the answer's content is sealed to that key
(HPKE in `mls-core`), so only the asking device can read it even if the server delivers it elsewhere
([history-answer-addressing](docs/wiki/protocols/history-answer-addressing.md#sealing-the-answer-to-the-asker---option-b-2026-11-17)).
