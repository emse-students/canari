### Fixed - "@" in a group or salon proposes its members at once

Typing "@M" in a group proposed nobody until several letters were typed: the suggestions came from the school-wide search (top 10) and were filtered to the members afterwards. A conversation now suggests from its own members locally: a bare "@" lists them, latest speakers first, each letter filters (accents ignored, any word of the name). Posts and comments keep the search. Mechanism in [chat](docs/wiki/frontend/modules/chat.md).
