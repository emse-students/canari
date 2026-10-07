### Fixed - the seen-ciphertext ledger evicts row keys before fingerprints, and its ledgers are bounded

Fingerprints and row keys each have their own cap and a user keeps at most 256 ledgers ([history-reconciliation](docs/wiki/protocols/history-reconciliation.md#the-seen-ciphertext-ledger-has-two-namespaces-and-two-bounds-2026-10-08)).
