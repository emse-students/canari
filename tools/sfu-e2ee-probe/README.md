# sfu-e2ee-probe - Q4: do E2E-encrypted call frames cross Cloudflare Realtime's SFU intact?

WP-GC3's first step ([backlog](../../docs/wiki/backlog.d/group-calls-p2p-mesh-up-to-4-audio-3-video-decided-2026-10-31.md)):
before any client or backend code is written against Cloudflare Realtime's raw SFU (the
sessions/tracks API), prove that frames the app's own E2E transform encrypted reach a subscriber
whole and open there. The result is recorded in
[calls-revival-plan section 14](../../docs/wiki/frontend/modules/calls-revival-plan.md#14-probes-of-2026-10-16-clients).

## Run it

In CI, by hand (the only place the DEV app's pair can be read - it is a write-only ENVIRONMENT
secret of `development`):

```sh
gh workflow run scheduled.yml -f job=sfu-probe            # add --ref <branch> to run a branch's copy
gh run watch <id>; gh run view <id> --log | grep sfu-q4   # the facts are also in the job summary
```

Locally, with an SFU app's pair in the environment (never as arguments) and Chrome installed:

```sh
CLOUDFLARE_SFU_APP_ID=... CLOUDFLARE_SFU_APP_SECRET=... bun tools/sfu-e2ee-probe/probe.mjs
```

Options: `--frames <n>` (audio, default 250), `--video-frames <n>` (default 150), `--audio-only`,
`--chrome <path>`, `--keep`. Exit 0 = PASS, 1 = FAIL with a named cause, 2 = not run (no pair).

## What it does

| File                   | Role                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe.mjs`            | The driver: launches two headless Chromes, calls the Cloudflare API with the app secret (the pages only ever see SDP), waits for a proof, prints the facts                                                                                  |
| `page/page.ts`         | One end: the publisher pushes its fake microphone and a VP8 camera, the subscriber answers Cloudflare's offer for the pulled tracks. Transforms are assigned in the task that created the sender, and in `ontrack` for a pulled transceiver |
| `page/probe-worker.ts` | The app's `encryption.worker.ts`, imported unchanged, with a read-only tap that digests each frame AFTER the sender transform and BEFORE the receiver transform                                                                             |
| `lib.mjs`              | The verdict (`failureOf`, `provenOf`) and the byte comparison (`compareDigests`), tested by `lib.test.mjs` (`make test-ci-scripts`)                                                                                                         |

The API sequence: `POST sessions/new` (A), `POST sessions/A/tracks/new` with the publisher's offer
and its tracks as `location: local`; once the publisher is `connected`, `POST sessions/new` (B),
`POST sessions/B/tracks/new` with the same track names as `location: remote, sessionId: A`, the
subscriber answers the returned offer, `PUT sessions/B/renegotiate`.

## What PASS means

- the subscriber's receiver transform decrypted at least `--frames` audio frames and
  `--video-frames` VP8 frames (one key frame among them) under the publisher's send key, which
  only the publisher holds - each frame crossed Cloudflare, the only peer either side has;
- zero frames failed to decrypt, zero transform errors, no frame met a transform before its keys;
- the transforms were not bypassed: packets received while the receiver transform was handed no
  frame, or opened none of a kind, FAILS (`CALL-E2E-BYPASS-MI9T`);
- every frame the receiver transform was handed is byte-identical to one the sender transform
  wrote.

No clock decides: every wait ends on a proof of success or failure, and the job's
`timeout-minutes` bounds a run in which nothing happens at all.

## What it does not cover

The keys are random bytes per direction, not an MLS export or `deriveGroupCallKeys`: keying does
not change the frame format, which is what Q4 asks. One runner, one network: it says nothing about
a phone, cellular or a campus network.
