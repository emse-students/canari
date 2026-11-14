## P3 - Path parameters are declared in chat-delivery too (2026-11-14)

target: 1.8.0

`@RouteParams` and its global guard ([social-service](../services/social-service.md#path-parameters-are-declared-and-one-global-guard-reads-the-declaration-2026-11-14))
cover social-service, core-service and media-service. chat-delivery has routes with path parameters
and neither the guard nor the coverage spec, so what each of its parameters is, and whether it is
checked, is still read handler by handler.

What is left: copy the guard and its spec (`route-params-copies.test.mjs` then holds the fourth
copy), provide it in `AppModule`, declare every parameter after reading what it reaches, and add
the coverage spec. call-service and chat-gateway are Rust and are not concerned.

Done when chat-delivery carries the same two specs.
