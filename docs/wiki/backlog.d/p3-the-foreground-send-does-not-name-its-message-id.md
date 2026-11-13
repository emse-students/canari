## P3 - the foreground send does not name its messageId, so an adopted orphan can still be queued twice

Since migration 048 the server stores one message per `(group, sender, device, messageId)` and
answers a repeat with the first copy's receive time
([chat-delivery](../services/chat-delivery.md#a-message-sent-twice-under-one-id-is-stored-once-migration-048-2026-11-13)).
The native senders have always named the id; the foreground `POST mls/send` does not
(`postApplicationMessage` in `mlsDeliveryApi.ts` posts no `messageId`, though `sendMessage` in
`BaseMlsService.ts` already receives it as `_messageId`). So a native send whose answer was lost,
then ADOPTED by the app at login (`adoptOrphanedMirrorEntries`) and sent by the foreground flusher,
is still queued a second time, and so is a foreground retry after a transport failure
(`DeliveryUnreachableError`).

**Why it was not done with the server half.** A server older than 048 refuses an unknown field on
that route (`send_field_refused`, `CLIENT_SEND_FIELDS`), and a store build reaches phones before the
stable deploys production. So the client half ships in a release AFTER the stable carrying 048 is
in production (or behind a capability the client reads first), never in the same one.

**The change, when that holds.** Thread the id from `sendMessage` through `emitFrame` to
`postApplicationMessage` and put it in the body when present; update the at-least-once comment in
`postApplicationMessage`, and its test (`mlsDeliveryApi.addressed.test.ts`).
