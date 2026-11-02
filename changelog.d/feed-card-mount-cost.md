### Changed - the Feed tab opens lighter: ASCII text skips emoji segmentation, the first "Voir plus" read waits for the layout observer

Plain-ASCII post text no longer goes through `Intl.Segmenter`, and the first overflow read of a clamped caption comes from the ResizeObserver instead of a forced layout per card ([community-open-budget](docs/wiki/frontend/community-open-budget.md#the-tab-taps-boot-work-named-feed-cards-not-boot-2026-11-02)).
