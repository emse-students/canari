### Changed - a salon open does less work per message bubble and per day separator

Each bubble built its own `Intl.Segmenter` to decide whether it was an emoji-only message, and mounted the media renderer even for plain text; each day separator built three `Intl.DateTimeFormat`s on every regrouping of the conversation. One segmenter and a scan bounded by five graphemes, the renderer only for an attachment, and one set of formatters per pass ([community-open-budget](docs/wiki/frontend/community-open-budget.md#per-bubble-and-per-day-work-cut-2026-11-08)).
