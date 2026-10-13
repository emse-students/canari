### Fixed - a second account in the same tab is asked for its own announcement

Sign-out now resets the announcement store, whose reset had no caller: the next account signing in in the tab was never asked and could see the previous one's ([performance-audit](docs/wiki/frontend/performance-audit-2026-10-12.md#what-the-audit-found-that-is-not-performance)).
