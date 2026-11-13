## P2 - the gateway's frame size and rate limits, sized from a week of its own counts

target: 1.10.0

**The order (lead, 2026-11-13).** First the counter, which changes nothing a client sees: one
`[WS FRAMES]` line per connection when it ends, with its frames, its largest frame and its busiest
minute ([chat-gateway](../services/chat-gateway.md#what-one-connection-sent-said-once-when-it-ends-2026-11-13)).
BUILT. Then, one week after the release that carries it, the per-connection frame size limit and
frame rate limit are chosen and land TOGETHER, as server variables, each refusal typed for the
client and logged with the connection's count - the shape of media-service's daily upload bound
(#3441).

**What the limits are sized from, and never from one of the two alone:**

- the week of `[WS FRAMES]` lines on production: the distribution of `largest` and of
  `peakPerMinute` (doubled: a fixed window can split a burst in two);
- the structural bound, derived from the code and not from traffic: what ONE legitimate action can
  make a client send in a minute - a commit and its Welcomes for the largest group, an outbox
  draining after a reconnect - at the largest group size the estate has.

**What was measured before the counter existed** (production, 2026-11-13, one read-only aggregate
of the delivery queue, which holds what is still stored and is therefore a sample):

| | p50 | p95 | p99 | max |
|---|---|---|---|---|
| distinct frames per sender per minute, last 30 days (2,414 sender-minutes, 207 senders) | 3 | 26 | 54 | 142 |
| stored frame, characters of base64 (bytes are about three quarters) | 1,324 | 7,264 | 10,208 | 239,996 |
| Welcome ratchet tree, characters (156 rows) | 2,996 | - | 60,888 | 65,000 |

A frame size limit of 1 MiB is the value those numbers point at; it waits for the week like the
rate, so both are chosen from the same reading.

**Owed.** The week's reading (aggregates only), the structural bound written here with the code it
was derived from, then the pull request that sets both limits.

**A follow-up to the counter: one line per closed connection, not two.** A connection the client
closes politely now ends on TWO lines: `Client closed connection` (`apps/chat-gateway/src/handlers.rs`,
written on a close FRAME only) and `[WS FRAMES]`. Where a close line already exists, the frame counts
fold into it; `[WS FRAMES]` stays the line for the endings that write none (a reset, the sender half
failing).
