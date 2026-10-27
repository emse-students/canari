# CanaRun - an activity card in a conversation (lot R1: the READER; the writer is off)

CanaRun is an activity - a run, a ride, a hike, a pool swim - sent **end-to-end encrypted** as a
card in a DM, a group or a community salon. The sender builds it from an imported GPX, TCX or FIT
file (lot **R2**, not built). **Lot R1 makes every client able to DISPLAY the card before any client
can SEND one**: a client that does not know an `AppMessage` kind used to drop it without a trace, so
the reader has to reach the whole fleet first.

## The product decisions (owner, 2026-10-27) - recorded, not to be relitigated

1. **The trace is trimmed 200 m at each end by default.** R2 does the trimming; the message carries
   `trimmed_m` and the card says so. An option sends the statistics only, with no trace.
2. **Sports and units**: running and hiking read as a PACE in min/km, cycling as a SPEED in km/h;
   **pool swimming is statistics only, never a trace** (a reader drops a pool swim's trace whatever
   the sender put in it). The sport is an enum with `UNSPECIFIED = 0` and an explicit pool-swim value.
3. **The trace is a bare inline SVG polyline.** No map tiles, no third-party request of any kind.
4. **Sources (R2)**: GPX, TCX and FIT import only.
5. **Destinations**: DMs, groups and salons. **Not the feed** or posts.
6. **The writer stays off until `minClientVersion` covers R1** (both stores serving it).

## The wire format

`AppMessage.run = 15`, inside `oneof kind` (`libs/proto/canari.proto`):

| Field | Type | Meaning |
| --- | --- | --- |
| 1 `sport` | `RunSport` | `UNSPECIFIED 0`, `RUNNING 1`, `CYCLING 2`, `HIKING 3`, `POOL_SWIM 4` |
| 2 `started_at` | int64 | Unix ms, the sender's clock |
| 3 `duration_s` | uint32 | elapsed time |
| 4 `moving_s` | uint32 | time in motion, `<= duration_s` |
| 5 `distance_m` | uint32 | |
| 6 `elevation_gain_m` | uint32 | |
| 7 `title` | string | optional |
| 8 `track_lat`, 9 `track_lon` | packed sint32 | at most 500 points, in units of 1e-5 degree; the first value absolute, each next one the delta from the previous point |
| 10 `trimmed_m` | uint32 | metres removed at EACH end before sending |

**Field 15 is numbered after `author_proof` (14), which sits outside the oneof.** mls-core appends
the proof as the LAST field of the bytes TypeScript encoded (`mls-core/src/authorship.rs`); protobufjs
writes fields by number, so a TypeScript RE-encode of a decoded frame carrying both would put 15
after 14 and break the trailer. Nothing re-encodes a decoded frame: the authorship records keep the
decrypted bytes as they came (`crypto/messageAuthorship.ts`).

## The reader - a peer's bytes, bounded in one place

Every value is somebody else's input: the live frame, and a history bundle that relays the stored
envelope as a STRING. Both end in `checkRunActivity` (`frontend/src/lib/canarun/activity.ts`), and
the stored envelope is checked again by `parseEnvelope` for that reason.

| Bound | Value | What breaks it |
| --- | --- | --- |
| points | 500 | checked before any integration, so an oversized list costs one comparison |
| coordinates | latitude within 90 degrees, longitude within 180, after integrating the deltas | refused at the first point off the globe |
| trace lists | same length | refused |
| statistics | non-negative integers; duration and moving time 30 days, distance 10 000 km, elevation 200 km, trimming 50 km | refused; `moving_s > duration_s` refused |
| start | 2000-01-01 to 2100-01-01 | refused (an absent start is 0) |
| title | 80 code points, control and bidi characters flattened | CUT, not refused |
| sport | a value this build was never taught | read as `UNSPECIFIED`, not refused |
| pool swim | carries a trace | the trace is DROPPED |

**A refused run is SHOWN as an unreadable row** ("Cette activite n'a pas pu etre affichee"), logged
at warn with the reason. Never a crash, never an unbounded drawing. The bounds are generous on
purpose: they say what no recording produces, not what is typical.

The card (`components/messages/RunCard.svelte`, from `MessageBubble.svelte`) shows the title (or the
sport), the sport and the start, the distance, the time, the pace or speed, the elevation, and the
trimming note when a trace is drawn. The trace is projected equirectangularly, longitude scaled by
cos(mean latitude), and fitted, aspect kept, into a fixed 320x160 viewBox (`canarun/trackPath.ts`).
A run card is neither edited nor forwarded (a forward is a send, and the writer is off).

**Every place that reads a frame or an envelope kind** was given the run: `appMsgToEnvelope`
(`utils/chat/messageUtils.ts`), which the DM live path, the Welcome replay, the salon live path, the
salon history decode, the DM history replay and the restored-authorship check all call; the DM live
branch, which used to be `text || reply || media` and now asks `isDisplayedDmKind`; `getPreviewText`
and `envelopeBodyText` (`envelope.ts`); and the quoted-reply preview (`utils/chat/messaging.ts`).

**The native push** (`src-tauri/src/mobile/proto_fields.rs`) announces a run frame as
"(runner emoji) Course : 5,2 km" / "Run: 5.2 km" (`PushText::Activity`, `push_text.rs`), metres for a pool
swim, the sport alone when the distance is zero or past the reader's bound.

## A kind newer than this build is SHOWN, not dropped (decided 2026-10-27)

This protects every FUTURE kind, not only the run. `decodeAppMessage` (`proto/codec.ts`), for a frame
carrying no kind this build knows, walks the wire for a field number `AppMessage` does not declare
(protobufjs discards unknown fields by default, so the decoded object no longer says it was there),
and `appMsgToEnvelope` answers an "unsupported" envelope: a neutral row reading "Ce message necessite
une version plus recente de Canari", logged at warn with the field number. Detected structurally,
never from any text. `APP_MESSAGE_KINDS` and `APP_MESSAGE_FIELD_NUMBERS` are asserted against the
proto by `codec.unknownKind.test.ts`.

**The consequence for whoever adds the next kind**: a kind that must stay INVISIBLE on an older
client (a control frame) cannot be a new oneof member, because every older build from R1 on draws it
as this row. It rides an existing control kind (a `SystemMsg` event), or its writer waits for a
`minClientVersion` that knows it.

**Not done, deliberately**: the row stores no copy of the frame, so a client that later learns the
kind does not redraw that row (the MLS key that opened it is gone). The native push of an unknown
kind stays the generic banner. The key-distribution groups (`graine/frameHandler.ts`) do not use this
path and are unchanged.

## The rollout: reader first, writer off, and the floor

1. **R1 (this lot)** ships the reader in every client. `RUN_WRITER_ENABLED = false` (`features.ts`),
   and `features.test.ts` asserts that no production file calls `mkRun` or `runActivityToProto`.
2. **The floor**: when both stores serve the first release carrying R1, `minClientVersion` is raised
   to it - against the recorded population, never a column most of the fleet did not write
   ([durable-rules](../../durable-rules.md#release-and-ci---cicd)).
3. **R2** builds the writer and flips the switch, only after the floor.

## Owed - R2, the writer

- The import: GPX, TCX, FIT; downsampling to at most 500 points; the default 200 m trimming at each
  end; the stats-only option; the pool swim sent without a trace.
- The composer entry in DMs, groups and salons, and not in the feed.
- **The privacy policy and the register, together** (`routes/legal/privacy/+page.svelte`,
  [register-of-processing](../../compliance/register-of-processing.md)): a trace is location data a
  member chooses to SEND, end-to-end encrypted, trimmed, and fetched from no third party. R1 changes
  neither - it collects and sends nothing, and the server still never sees a trace - so the line is
  written with the writer.
- `RUN_WRITER_ENABLED` flipped in R2's own commit, after the floor.

See also: [sharing](../sharing.md) (CanaRun builds on the share-IN half for a file opened from a
sports app), [chat](chat.md), [legacy-compatibility](../../legacy-compatibility.md).
