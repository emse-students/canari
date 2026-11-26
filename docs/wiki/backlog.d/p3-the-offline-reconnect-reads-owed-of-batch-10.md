## P3 - Reading owed: the native chat socket's typed connect failure and the media bubble's redraw on reconnection (batch 10, 2026-11-25)

target: 1.8.3

Two fixes shipped compile- and unit-verified only; each is closed by one reading on a phone.

1. **Native socket, offline** (`tauri-plugin-websocket` patch, `nativeSocketConnect.ts`). The patched
   plugin rejects a failed TCP connect as `{ kind: 'connect', message }`, and the page types it as a
   `TransportFailureError`. Reading, on the Mi 9T: cut the network (airplane mode) with the app open
   and let the reconnect ladder run; the log carries ONE `[WS] Gateway connection failed - the link is
   down` line per rung and NO `console.error` with a stack. A handshake a server refuses (a bad token)
   must still log as an error.
2. **A file bubble after an outage** (`MessageBubble.svelte`, `readMediaBody`). Send a large file, cut
   the Wi-Fi once it is sent, restore it: the bubble draws the file without a tap, and the failure is
   logged as `media not shown (unreachable)` at `warn`, not `(other)` at `error`. iPhone 12 and Mi 9T.
