### Fixed - a type error in a NestJS service, its specs included, now fails the push

Jest runs ts-jest with `isolatedModules`, so specs are transpiled without types and #3989 shipped
TS2345/TS2493 in a scheduler and its spec. The push now runs `tsc --noEmit` for each service its
range touches, 4-11 s each ([cicd](docs/wiki/cicd.md#checks-at-commit-at-push-and-in-ci-only)).
