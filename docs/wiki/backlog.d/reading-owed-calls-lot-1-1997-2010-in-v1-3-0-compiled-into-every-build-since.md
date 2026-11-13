## Reading owed - calls lot 1 (#1997, #2010, in `v1.3.0`; compiled into every build since #2299, production still `calls_mode` off): 1:1...

target: 1.7.0

**What is built:** calls lot 1 (#1997, #2010, in `v1.3.0`; compiled into every build since #2299, production still `calls_mode` off): 1:1 audio peer to peer, never placed on a phone ([bench readings](../device-readings-calls-live-2026-10-18.md#1-calls---blocked-no-build-within-reach-carries-lot-1))

**The reading that closes it:** on dev, the next pre-release: a call PC <-> Mi 9T and Mi 9T <-> iPhone 12 - setup time, the selected pair (direct or Cloudflare TURN), audio heard both ways, the ring on a throttled uplink, and a key mismatch (the per-direction key and AAD of `callFrameAad.ts`)
