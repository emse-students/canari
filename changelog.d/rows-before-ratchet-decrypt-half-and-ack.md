### Fixed - a message decrypted but not yet stored can no longer be lost to a checkpoint or an early acknowledgement

A checkpoint now waits for every frame between its decrypt and its row before it exports, a failed live row write is kept and retried like a batch's, and an application frame is acknowledged only once its row is stored ([chat](docs/wiki/frontend/modules/chat.md#rows-before-ratchet-the-decrypt-half-and-the-ack-2026-11-19)).
