## The live viewer cap (24 seats for the whole host) lifted in measured steps - the owner's "no visible ceiling" (2026-10-21)

target: 1.9.0

**Owner, 2026-11-19:** a viewer is NEVER refused. Quality steps down to the lowest rung; a viewer past what that rung carries waits on "Connexion au direct..." until a seat frees ([decisions](../decisions/owner-decisions-of-2026-11-19.md)).

Split on 2026-11-17 from the WP-L8 moderation entry, which is closed in code: the cap is not
moderation, and no code can lift it before the owner's decisions and the measurements below. The
design, the bounds and their arithmetic are on [live-scaling](../frontend/modules/live-scaling.md);
the ladder of steps is section 6 of [live-production](../frontend/modules/live-production.md#6-the-viewer-cap---from-24-to-none-in-measured-steps).
Today: `LIVE_VIEWER_CAP` = 24 seats for every live together, a refusal ("Live complet"), never a
failure. Charter: principle 4 (independence) and 7 (simplicity) weigh the R2 processor below.

**ANSWERED by the owner on 2026-11-17** ([live-scaling 7](../frontend/modules/live-scaling.md#7-the-decisions-owed-by-the-owner),
[decisions](../decisions/owner-decisions-of-2026-11-17.md)): **no R2 and no Cloudflare Stream - the lives stay on
the server, the quality steps down** (O-1 no for now, the storage kept S3-generic so a self-hosted
store stays possible; O-2 and O-4 moot; O-3 (i) as the standing state, a refused viewer meeting the
"Connexion au direct..." retry, never `live complet`; O-5 yes, D2 reversed). **The steps below that
name R2 (stage 2) are superseded by [live-scaling 3](../frontend/modules/live-scaling.md#3-the-recommendation)**:
the cap is re-derived from the measured egress
([entry](live-host-egress-constant-rests-on-the-workstation-path.md)), then the live's tier steps
down instead of refusing. The link-speed question to the school IT department (G14) stays.

**The ordered steps, each a pull request ending on its measurement:**

1. **Stage 0, a headless viewer swarm** for the local estate (the WP-L1 rig injects a broadcaster
   and has no viewers): 24 / 100 / 300 viewers polling, polls/s, social-service CPU, pool wait,
   Redis scripts/s, p95 manifest latency. About 3-4 days.
2. **Stage 1, the manifest stops costing a full check per poll** (F1 one seat set per live, F2 the
   gate on a seat lease, F3 a server-told `pollAfterMs`), measured before and after with step 1.
   About 1-2 weeks, server and client, an adversarial review.
3. **S1, the bitrate measured in the app WebViews at the 2.0 Mb/s ask** on both phones (the cap can
   go down as well as up). A day of readings.
4. **Stage 2, segments to R2 on dev** after O-1 and O-2: the bucket, `segmentBase`, CORS, CSP, the
   purge, register C19 and the privacy text (HELD for the owner's reread). About 2 weeks.
5. **Stage 3, the visible cap goes**: seats count and never refuse, `LIVE_FULL` retired, the
   admission rate and the per-account limits in place, `limit_conn` per address deleted. About a
   week, then the first announced production live.
