# MLS client package boundaries

## Preventive (normal online operation)

Measures that avoid entering bad MLS states when the network and processes behave as expected.

- Single MLS tab leader + `BroadcastChannel` coordination (see `tabLeader.ts`).
- Distributed add lock (`acquireAddLock` / `releaseAddLock` on `IMlsService`).
- Server-side commit epoch validation (client uses `commitBaseEpochForValidation`).
- Shared delivery HTTP helpers (`mlsDeliveryHttp.ts`): gateway/delivery base URLs, keepalive POST, response assert - used by Web and Tauri MLS services.
- Ordering assumptions for Welcome vs commits (handled in the message pipeline).

Relax only when duplicates are provably benign and local MLS state cannot diverge.

## Resilience (partitions, crashes, multi-device)

Measures that restore correctness after failures or delays.

- Redis delivery queue + ACK policy (`mlsQueueAckPolicy.ts`).
- Reconnect drain, `forgetGroup` / reinvite, phantom-group handling (message pipeline).
- Push wake (platform services).

Keep guarantees; simplify implementation only behind tests and metrics (`mlsRecoveryMetrics.ts`).
