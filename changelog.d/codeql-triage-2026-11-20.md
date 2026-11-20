### Security - a dragged-in image address is fetched under the browser's rules, and session log entries stay on one line

On Tauri, a picture dragged into a composer from another page is now fetched by the WebView's own `fetch` (no credentials, CORS applies) rather than the native HTTP client; `appendLog` writes a line break inside an entry as `\n`; the colour probe of `imeGround` no longer writes `fillStyle` twice. Triage of the open code-scanning alerts ([chat](docs/wiki/frontend/modules/chat.md)).
