## P3 - the vendored websocket plugin: four upstream behaviours found by the review of #2167

target: 1.10.0

All four are upstream behaviour kept by the vendored copy (`frontend/src-tauri/patches/tauri-plugin-websocket/src/lib.rs`), none introduced by the happy-eyeballs patch.

- **`send` holds the global `ConnectionManager` mutex across `write.send(...).await`.** A stalled send (a dead peer, a full buffer) blocks every other `send`, and the registration in `connect`, until it resolves. Fix: release the lock before awaiting (take or clone the writer out first).
- **Frames can reach the Channel before the page calls `addListener`, and are dropped.** `connect` returns the id, then the page registers its listener (`TauriMlsService`, `this.ws.addListener`) while the read task is already running. So even an ON-TIME socket can lose the gateway's `pending_welcome_notify` drain (`apps/chat-gateway/src/handlers.rs`, which deletes the key once the send succeeded), not only a late one ([mobile](../frontend/mobile.md)). Fix direction: buffer frames until the first listener exists.
- **The writer is removed only on `Message::Close`.** A read error, or a page reload during or after `connect`, leaves a registered writer and a live socket for the life of the process. Fix: remove the writer when the read stream ends for any reason, and when the window is destroyed.
- **The `every address failed` WARN is reported twice**: once by `happy_eyeballs.rs` (`[WS-NET] ... could not connect`) and once by the caller that logs the rejection with its reconnect decision. Keep the one that carries the decision.
