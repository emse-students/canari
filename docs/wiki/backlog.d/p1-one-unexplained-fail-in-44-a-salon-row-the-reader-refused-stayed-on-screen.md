## Reading owed - a refused salon row still drawn, at its next recurrence

target: 1.7.0

The reader logged the refusal every time, yet once in 44 runs the refused message was still rendered. There are two candidates:

- **A drawn row.** Two overlapping loads could each leave a stored-page row unwithdrawn. This is fixed by #2245, and its test fails on the old code. It was never seen in a trail: on 35 instrumented runs the tampered row was not in the drawn copy.
- **A live row.** A row that reached memory live and was verified on arrival is kept by the merge's window rule when a later page refuses it while it is the newest (`messageMerge.ts`). This is by design, and it is written down in [community-open-budget](../frontend/community-open-budget.md#f4-built-2026-10-15).

GRAINE-AUTH's trail now keeps the load lines and every line naming the tampered row. A loop on the estate waits for a recurrence that carries this evidence.

**Every way a salon message reaches memory, read 2026-10-22** (`frontend/src/lib/`):

| Path | Checked before it is shown? |
| --- | --- |
| Live frame (`messagePipeline/channelEventHandler.ts`) | Yes: `openChannelMessage`, with the author bound by the session. A frame WITHOUT a ciphertext was rendered under the author the server named, with no check; it is refused since the fix that follows this table. |
| History page (`composables/useConversations.svelte.ts`, `loadChannelHistory`) | Yes: `decodeChannelMessageRow`. |
| Stored-page draw (`drawStoredSalonPage`) | Not re-verified. The rows were verified when stored, and any row the next merged page does not name is withdrawn (#2245). |
| Whole-history search (`searchChannelHistory`) | Yes: `decodeChannelMessageRow`. |
| Reconnect and catch-up | Yes, through the history page. Salons have no replay queue. |
| Reactions and edits, live, history and search | Yes; an edit is also checked against its target's author. |
| History bundle, boot restore, landing preview, scrollback | Not a path: salons are excluded from each. |
| Own echo and unsent resend | Local text by this device's own user. |
| Tab sync (`components/layout/ChatBackgroundService.svelte`) | Trusts the leader tab, whose row came through the paths above. |

A row under a v1 session this device still holds carries no author proof. That is the documented legacy of [channel-encryption](../protocols/channel-encryption.md), and it ends with the v1 reader.

_Context, from the former backlog section "The harness itself":_ Open findings about the instrument; the reasoning is on
[cross-client-harness-findings](../cross-client-harness-findings.md). **DECIDED 2026-10-18: the whole test tooling is reformed NOW, not after a wholesale rig change** (user: "on est a un nombre de test aberrant") - [WP-TEST-TOOLING-REFORM](decided-by-the-user-on-2026-10-18-every-design-question-answered.md); the "waits for a wholesale rig change" lines below are that reform's scope.
