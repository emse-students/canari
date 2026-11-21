## P3 - perf: iOS opening a salon loads the history page 4 times within 50 ms (S17, 2026-11-20)

target: 1.7.3

Read on the iPhone 12, sitting S17 of 2026-11-20: opening a salon requests the same history page four times within 50 ms. Several openers each start the load with nothing coalescing them. Name the overlap and delete it, so one open is one load (a ledger that reconciles afterwards is a witness, never the fix). Verify by counting history requests for one open, on both phones and the web. Context: [history-reconciliation](../protocols/history-reconciliation.md).
