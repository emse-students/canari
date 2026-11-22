## P3 - noise: `lives_mode relayed to media-service: on` is logged on every live segment (S17, 2026-11-20)

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

Read in the server log, sitting S17 of 2026-11-20: `lives_mode relayed to media-service: on` appears for every live segment. The relay of a platform setting is a decision made once when it changes (or at boot), not an event of each segment; the line either belongs to a per-request path that should not log, or the value is being re-relayed each time, which is traffic. Find which, and log only the change. Context: [core-service](../services/core-service.md).
