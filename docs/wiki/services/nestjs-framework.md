# The NestJS framework across the four services

One page for the fact that spans `core-service`, `chat-delivery-service`, `media-service` and
`social-service`: which major of NestJS each runs, why they are not all the same today, and what
the ESM-only framework did to the test runner.

Per-service behaviour lives on that service's own page ([core](core-service.md),
[chat-delivery](chat-delivery.md), [media](media-service.md), [social](social-service.md)). This
page is only about the framework underneath them.

## Where each service stands, 2026-08-31

| Service | `@nestjs/common` / `core` / `platform-express` | Satellites | Suite |
| --- | --- | --- | --- |
| `media-service` | **12** | - | 14 |
| `core-service` | **12** | `config` 12, `typeorm` 12 | 202 |
| `chat-delivery-service` | **11**, held | `typeorm` 12 | 308 |
| `social-service` | **11**, held | `config` 12, `schedule` 12, `axios` 12, `typeorm` 12 | 588 |

**The split is deliberate and it has exactly one cause.** `@nestjs/throttler` has published no
release that declares NestJS 12: its latest, `6.5.0`, stops at `^11.0.0` for both `@nestjs/common`
and `@nestjs/core`. The two services that rate-limit a route import it, and the two that do not are
on 12.

Nothing else blocked the move. With `@nestjs/common`, `@nestjs/core` and `@nestjs/platform-express`
at 12 in `chat-delivery-service`, **307 of its 308 tests passed** - the single failure was
`framework-boot.spec.ts` reading `@nestjs/throttler`'s own manifest and refusing the combination.
That is the test doing the job it was written for after the 2026-08-31 `platform-express` incident,
and it is why the update was reverted rather than shipped.

### Holding two services back rather than all four

The alternative was to keep every service on 11 until throttler moves. It was rejected: a
third-party rate limiter should not decide when the framework carrying four deployed services gets
security fixes, and the four are four independent containers with four `node_modules` - the split
costs nothing at runtime. What it costs is one row of this table, which is why the table exists.

### How the hold ends, without anybody watching for it

No `dependabot.yml` ignore, no calendar entry, no ceiling entry in
[`dependabot-auto-merge.sh`](../../../.github/scripts/dependabot-auto-merge.sh). The pull requests
raising `@nestjs/core` to 12 on those two services are **red, open, and correct to be open**:

1. `framework-boot.spec.ts` fails on them today and prints the violation, which now
   [names its own remedy](../../../apps/chat-delivery-service/src/framework-boot.spec.ts) in both
   directions rather than only listing a mismatch.
2. The day `@nestjs/throttler` ships a release accepting `^12.0.0`, Dependabot bumps it on `main`.
3. The hourly sweep marks those branches STALE - their green checks predate what `main` gates on -
   and updates them, which re-runs CI with the new throttler resolved.
4. `framework-boot.spec.ts` goes green by itself, and the sweep merges them on the next pass.

**Nothing in that chain is a clock or a reminder.** The hold is expressed as an assertion about the
resolved tree, so it expires exactly when its reason does.

### Satellites move on their own schedule, and that is not a skew

`@nestjs/config`, `@nestjs/schedule`, `@nestjs/axios` and `@nestjs/typeorm` were renumbered onto the
framework's major - `4.x` and `6.x` jumped straight to `12.x`. **The number is a label, not a
requirement**: each declares `^11.0.0 || ^12.0.0` (or wider) for `@nestjs/common`, so all four
install cleanly on a service still running the 11 core. Reading the peer range rather than the
version number is what let four more Dependabot pull requests merge with the framework major still
blocked.

## NestJS 12 is ESM-only, and jest is the only thing that noticed

`@nestjs/common@12` declares `"type": "module"` with a single `exports` map pointing at ESM. There
is **no CommonJS build at all**. Every service here compiles to CommonJS (`"module": "commonjs"`)
and ships as `bun dist/main.js`.

**The runtime was never the problem, and it was measured rather than assumed.** Node 24 and bun both
`require()` NestJS 12 from CommonJS without complaint - Node has supported `require(esm)` for
synchronous module graphs since 22.12. The compiled `dist/` runs, and `core-service`'s real
`AppModule` instantiates every controller, provider and `TypeOrmModule` under 12, failing only when
it reaches for a Postgres that is not there.

**jest was.** Test files run inside jest's own module registry, not Node's, and that registry only
gains `require(esm)` when `vm.SourceTextModule` exists - which happens under
`--experimental-vm-modules` and nowhere else:

```
$ node -e "..."                          SyntheticModule undefined | hasAsyncGraph undefined
$ node --experimental-vm-modules -e ...  SyntheticModule function  | hasAsyncGraph function
```

Without it, every suite in a service on NestJS 12 dies at import with `Must use import to load ES
Module`.

### Why the flag is in the command and not in the environment

CI runs these suites with `node --run test`, which executes the `package.json` script **without a
shell**. A `NODE_OPTIONS=... jest` prefix is shell syntax; it works under `bun run` and is silently
inert under `node --run`. So every jest invocation in all four services now reads:

```
node --experimental-vm-modules --disable-warning=ExperimentalWarning node_modules/jest/bin/jest.js
```

Passing the flag on `argv` also gets it to jest's workers, which inherit `process.execArgv` -
verified by running the suite with several workers and watching it pass.

`--disable-warning=ExperimentalWarning` is there because the flag makes Node print one
`ExperimentalWarning` **per worker**, on every run of every suite. That line is expected and carries
no information a reader does not already have from the command that produced it, so it is silenced
at the point that causes it rather than learned-to-be-skipped.

### The `uuid` exemption did not become unnecessary - it became wrong

Three services carried `"transformIgnorePatterns": ["node_modules/(?!(uuid)/)"]` in both their
`jest` block and their `jest-boot.json`, so that ts-jest would rewrite the ESM-only `uuid` into
CommonJS. That was the only way jest could load it.

Under `--experimental-vm-modules` jest resolves `uuid` through its ESM path, and the rewritten file
is then evaluated **as a module** - where `exports` does not exist:

```
ReferenceError: exports is not defined
  at node_modules/uuid/dist-node/index.js:5:23
```

The exemption is removed from all four services. This is the general shape of the thing: a
workaround for a missing capability turns into a defect the moment the capability arrives, and
nothing announces it.

## What is still owed

- `@nestjs/throttler` accepting `^12.0.0`, which lifts the hold on two services with no work here.
- `@nestjs/schematics@12` declares a `prettier ^3` peer. **Nothing in this repository is formatted
  by prettier** ([oxfmt is](../../../oxfmt.json)), the peer is optional, and it is not installed. It
  is named here so the unmet peer is a decision on the page rather than a surprise in a log.
- The four `framework-boot.spec.ts` copies are identical by design - each one answers for the
  `node_modules` of its own service, and a shared copy would answer for whichever tree it happened
  to load. Keep them in sync by copying, not by importing.
