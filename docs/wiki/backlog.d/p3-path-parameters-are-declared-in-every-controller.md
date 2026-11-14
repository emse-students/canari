## P3 - Path parameters are declared in every controller, not only the associations one (2026-11-14)

target: 1.8.0

`@RouteParams` and its global guard ([social-service](../services/social-service.md#path-parameters-are-declared-and-one-global-guard-reads-the-declaration-2026-11-14))
shipped with `AssociationsController` converted. A path id that is not a uuid is a `400` there; on a
controller still in the `PENDING` list of `route-params.coverage.spec.ts` it is whatever that
controller did before, pipe by pipe. What is left,
in order (decided 2026-11-14):

1. `ChannelsController` and `CommunityNicknamesController`, after reading the column type behind
   `channelId`, `workspaceId`, `messageId` and `roleId` - not assumed to be uuids.
2. Every other name in `PENDING`, the `internal/*` controllers last; then delete the
   `ParseUUIDPipe` each declaration makes redundant (one source of truth) and the `PENDING` list
   itself, so the spec judges every controller.
3. The same mechanism in core-service and media-service, in a pull request of their own.

Done when `PENDING` is gone in social-service and the two other services carry the same two specs.
