## P2 - a service-to-service call can still be reset while its peer is retired: the rotation covers only nginx (2026-11-01)

The replica lists take a retiring replica out of the two nginx before it stops
([cicd](../cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to)), so a request that goes
through nginx is never reset by a release. A call from one service to another does not go through
nginx: it resolves its peer through Docker's DNS, which names the retiring replica until it stops.
The callers, enumerated in both compose files by the second review of #2866:

- chat-gateway -> chat-delivery-service (`DELIVERY_SERVICE_URL`: the message-send path itself) and
  -> social-service (`SOCIAL_SERVICE_URL`);
- core-service -> social-service (`FORM_URL`, `FORM_SERVICE_URL`);
- social-service -> core-service (`USER_SERVICE_URL`, `PAYMENT_SERVICE_URL`) and
  -> chat-delivery-service (`DELIVERY_INTERNAL_URL`);
- frontend-ssr -> core-service, social-service, chat-delivery-service.

For them, `wait_unqueued`'s two clean reads of the retiring replica's accept queue are a clock, not
a proof: a call can arrive after them and be reset when the listener closes. Not observed; nothing
measures it either - the rig's load goes through the edge only.

**What closes it is a design decision, not built:** the callers reaching their peers through the
frontend nginx (or a second rotated proxy) so the same take-out covers them, or a client-side
retry on a connect refused / reset BEFORE a byte of the request was acknowledged. **The test that
closes it:** a rig case sending POSTs from one fixture service to another across a release of the
second, all answered.
