### Changed - the Feed tab opens lighter: ASCII text skips emoji segmentation, "Voir plus" measures batch on one frame

Plain-ASCII post text no longer goes through `Intl.Segmenter`, and the first overflow read of every clamped caption happens once per frame instead of one forced layout per card ([community-open-budget](docs/wiki/frontend/community-open-budget.md#the-tab-taps-boot-work-named-feed-cards-not-boot-2026-11-02)).
