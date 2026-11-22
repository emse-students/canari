### Fixed - a salon keeps the order its texts were written in across a server outage

Texts written while the server was down used to reach it in the order their retries ended (`T1 T6 T7 T8 T2 T3 T4 T5` on the iPhone). Each salon now sends through one ordered lane (texts, files, polls and forwards), so no later message overtakes an earlier one still waiting, and the repeat proof that made an unsent text step aside is retired ([chat](docs/wiki/frontend/modules/chat.md#a-salon-is-received-in-the-order-it-was-written-one-lane-per-salon-2026-11-22)).
