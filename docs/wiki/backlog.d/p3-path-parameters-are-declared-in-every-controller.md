## P3 - Path parameters are declared in core-service and media-service too (2026-11-14)

target: 1.8.0

`@RouteParams` and its global guard ([social-service](../services/social-service.md#path-parameters-are-declared-and-one-global-guard-reads-the-declaration-2026-11-14))
cover every controller of social-service, where the declaration is the one mechanism and no path
parameter carries a pipe. What is left (decided 2026-11-14): the same mechanism in core-service and
media-service, in a pull request of their own - the decorator and the guard shared rather than
copied, each service with its coverage spec walking its own `AppModule`.

Done when the two other services carry the same two specs and no path parameter of theirs is
validated by a per-parameter pipe.
