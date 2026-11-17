### Fixed - a passing DNS failure on a link preview or link-safety check answers 502, not a 500 with an ERROR stack

The SSRF guard's own lookup now types `EAI_AGAIN` as an unreachable upstream and a missing name as the caller's 400 ([chat-delivery](docs/wiki/services/chat-delivery.md#one-fetch-per-page-per-six-hours-not-one-per-reader-per-render)).
