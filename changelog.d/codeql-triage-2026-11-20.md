### Security - a dragged-in web image is fetched only from Canari's own hosts, and the in-app log keeps every Unicode line break on one line

A picture dragged into a composer from another page is fetched only when the `connect-src` the runtime enforces allows its origin, through the WebView's own `fetch` with no credentials; every other origin is refused up front with the existing toast. The in-app log now also folds NEL and the Unicode line and paragraph separators, and the `imeGround` colour probe never writes `fillStyle` twice in a row ([chat](docs/wiki/frontend/modules/chat.md)).
