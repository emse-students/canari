### Changed - Opening a salon mounts only the rows its pane is missing, then widens in small steps

A thread of one-line rows mounted 60 hidden rows before its first paint (one ~260 ms task on a Mi 9T) for the 40 px of overflow a scroll needs. The fill pass now asks for the rows the first frame measured it lacks, the widen after the reveal runs 10 groups per task, and the bubbles share one pointer query ([community-open-budget](docs/wiki/frontend/community-open-budget.md#the-salon-mount-named-60-rows-mounted-before-the-reveal-not-20-2026-11-02)).
