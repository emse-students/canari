## P3 - the phone polls presence every ten seconds over a live WebSocket (2026-09-02)

target: 1.8.0

Still so (`presenceStore.ts`). DECIDED 2026-10-18: presence is visible to those who share a conversation or community with the person, then the poll becomes a push ([WP-PRESENCE](decided-by-the-user-on-2026-10-18-every-design-question-answered.md), [detail](../protocols/campaign-measured-defects.md#the-presence-poll-logcat-2026-09-02)). **The audience half is BUILT and SHIPPED (#2031, `v1.3.0`); the push is NOT** - it needs a presence-transition event the gateway does not emit, a per-connection watch set checked against the audience, and a client that polls until the gateway proves it pushes ([chat-gateway](../services/chat-gateway.md#who-may-see-whose-presence-wp-presence-2026-10-18)). This entry closes with the push, not before.

_Context, from the former backlog section "MLS state, device healing and delivery - the defects the campaign measured":_ Open entries only; each carries a title, what is left and a link. The measurements, recurrences and
refuted readings are on [campaign-measured-defects](../protocols/campaign-measured-defects.md), the
cold-start ledger on [history-reconciliation](../protocols/history-reconciliation.md).
