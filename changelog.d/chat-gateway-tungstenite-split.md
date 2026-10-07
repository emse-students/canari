### Fixed - a client goodbye was logged as an unclassifiable ERROR again

A lone dependency bump had split `tokio-tungstenite` from axum's, blinding the classifier; it is pinned back, guarded by a test and a Dependabot ignore ([chat-gateway](docs/wiki/services/chat-gateway.md)).
