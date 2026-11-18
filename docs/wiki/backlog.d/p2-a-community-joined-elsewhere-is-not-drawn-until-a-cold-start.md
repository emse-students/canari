## P2 - A community joined from another device, or just joined, is not drawn until a cold start or a reload

target: 1.7.0

_2026-11-17, scope cut: KEPT in `1.7.0` - the paths it names changed since `v1.6.12`: `git log v1.6.12..origin/main` on `useChannelWorkspaces.svelte.ts` and `workspaceSnapshot.ts` lists #3676, #3682 and #3687 (2026-11-16), and `ChatBackgroundService.svelte` #3704 and #3725 ([decisions](owner-decisions-of-2026-11-17.md))._

Two observations of 2026-11-17 on `1.7.0-alpha.8` ([readings](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha8-both-phones-one-sitting)), cause not established:

- **iPhone 12 (`gamma`)**: `gamma` had joined a community from its web seat; the iPhone app, brought
  back from suspended and left in the foreground for five minutes on the communities screen, did not
  list it (17 communities, the new one absent, the rail scrolled to its end). A `terminate` and a
  launch listed it at once.
- **Web seat (`delta`)**: right after joining a community by its link, the salon showed loading
  skeletons for about three minutes with messages sent after the join already on the server; a
  reload drew them.

Neither path logged an error that names it. The next reading captures the iPhone's in-app log across
the resume (`[WORKSPACE-LOAD]`, `[WORKSPACE-SNAPSHOT]`) and the web seat's console from the join,
to say whether the workspace event never arrived or arrived and was not applied.

### The capture of 2026-11-18 (sitting S3, `1.7.0-alpha.11`, build `100700011` on both phones)

The iPhone 12 as `gamma` (in-app log pulled with `applog.mjs`), the Mi 9T as `alpha` (WebView console
over CDP), their web seats W4 and W1, and W2 (`beta`) creating each community and its invitation link.
Every join was made on the web seat of the phone's own account, the phone on the communities screen.

| Trial | Phone state at the join | Drawn? | What the phone logged |
| --- | --- | --- | --- |
| iPhone 1 | foreground, socket up | **yes, under 1 s** | `[WORKSPACE-LOAD] community joined in-session - loading its salons` 0.3 s after the web click, then `GET /api/channels/workspaces/user/me` and the listing |
| iPhone 2 | home pressed, socket released (`[WS] Paused - disconnect sent, socket released until the next foreground.`) | **no** - not drawn in 4 min 20 s of foreground | see below |
| iPhone 3 | the same | **no** - nor after a second background/foreground round | the same lines |
| iPhone, cold start | `terminate` + launch | yes | `[WORKSPACE-SNAPSHOT] the list on screen is the server's now (17 community(ies))` - both missed ones |
| Mi 1 | foreground, socket up | **yes, 2 s** | `community joined in-session`, `communities/channels loaded (attempt 1)` |
| Mi 2 | home pressed; the socket dropped (`4 pings without server response - closing zombie connection`, then DNS failures while dozing) | **no** - not drawn in 60 s of foreground | the same lines as the iPhone |

**Where the paths diverge: the return to the foreground.** What a returning phone logged, in order
(iPhone 2, local time; the Mi's lines are the same words):

```
03:27:16.121 [LIFECYCLE] App in foreground - re-arming watchdogs and reconnecting...
03:27:16.347 [WS] Connected to Chat Gateway
03:27:16.459 [UNREAD] live stream back: 12 salon(s) unread on the server, 0 count(s) moved here
03:27:16.471 [PENDING] No pending MLS messages for ...
03:27:17.881 [SYNC] 15 group(s) kept on the answer this connection pass already had - not asked again
```

and then nothing about communities: no `[WORKSPACE-LOAD]` line and no `GET /api/channels/workspaces/user/me`.
**What arrives:** the reconnect, the unread counts (12 salons, one more than the 11 before the join - the
new community's salon is counted by the server and moves no count here, since the device lists no such
salon), the MLS pending pull. **What is missing:** the `channel.member.joined` the server published
during the join (`announceSalonJoined`, to every member of the community, the joiner's other devices
included) went to a socket that was not there, and nothing replays it - the pending pull covers MLS
messages only. The two triggers that could list again, the `visibilitychange` (`'foreground'`) and
`connectivity.onReconnect` (`'reconnect'`), both reach `retryFailedListing`, which returns silently when
`workspacesLoadError === null`: it lists again only after a listing that GAVE UP. So a community joined
while the socket was down is drawn only by the next full listing, which is a cold start or a reload.

**Not a regression on this evidence**: `retryFailedListing` and the `handleVisibility` / `handleReconnect`
wiring in `ChatBackgroundService.svelte` are unchanged since `v1.6.12` (diffed). The lead re-judges the
`target:` line on that.

**The "just joined on this device" variant did not reproduce, 3 of 3**: the Mi (by its own link, in
the WebView), W1 and W4 each joined a fresh community, `beta` posted two messages within 2 s, and all
three drew them within 12 s with no loading skeleton (`[aria-busy=true]` and skeleton classes: 0).
The 2026-11-17 web observation (`delta`, three minutes of skeletons) stays unexplained.

What a fix has to answer, from this capture: a socket gap is a window in which `channel.member.*`
events are lost by construction, so the return from it (the reconnect after a gap, or the foreground)
must re-list the communities - or the unread answer that already names an unknown salon must trigger
the listing. The reading that closes it: trial iPhone 2 and Mi 2 again, the community drawn within
seconds of the foreground.
