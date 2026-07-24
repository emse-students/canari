# Calls module

**Routes**: `src/routes/calls/` (if standalone)  
**Components**: `src/lib/components/calls/`, `src/lib/composables/useCallSession.svelte.ts`  
**Service**: `src/lib/services/CallService.ts`

## Responsibilities

- WebRTC audio/video calls within MLS groups (E2E encrypted).
- CallKit integration on iOS (native incoming call UI, app killed).
- Full-screen intent + ringing on Android.
- Room token management via [`chat-delivery-service`](../services/chat-delivery.md#calls).
- SFU relay via [`call-service`](../services/call-service.md) (WebSocket signaling + media forwarding).
- Sibling device detection (call on another device → hide incoming UI).

## Architecture

```
Caller                                Callee
  |                                      |
  | 1. Click call button                 |
  | 2. POST /api/calls/initiate          |
  |    ← roomId + roomToken              |
  |                                      |
  | 3. MLS send: SystemMsg               |
  |    { call_invite, callId, hasVideo }  |
  |    (SILENT push - no generic notif)  |
  | 4. POST /api/calls/ring              |
  |    → backend fans out ring signal     |
  |                                      |
  |                           5. FCM/APNs push arrives
  |                              → ring signal triggers:
  |                                - Android: CallStyle notification
  |                                - iOS: CallKit incoming call
  |                                |
  |                           6. User answers
  |                              → MLS send: SystemMsg { call_answered }
  |                              → POST /api/calls/ring-end (answered)
  |                              |
  | 7. Both connect WebSocket            |
  |    → call-service:3004/ws            |
  |    → Join { room_id, room_token }    |
  |    → WebRTC negotiation              |
  |    → E2E-encrypted media flows        |
  |                                      |
  | 8. Hangup:                           |
  |    → MLS send: SystemMsg { call_hangup }
  |    → POST /api/calls/ring-end (ended)
  |    → close WebSocket                  |
```

## Call signaling (MLS)

Call signaling is carried inside MLS ciphertext for E2E privacy. System messages are sent **silently** (no generic notification):

| SystemMsg event | Sent by | Purpose |
|---|---|---|
| `call_invite` | Caller | Invite group members to a call (`callId`, `hasVideo`) |
| `call_answered` | Callee | Accept the call |
| `call_hangup` | Any participant | End the call |

The separate `POST /api/calls/ring` and `POST /api/calls/ring-end` endpoints handle the push notification layer (the backend cannot read MLS, so the caller's client explicitly tells it to ring other devices). Both are membership-gated.

## Call flow states

| State | Description |
|---|---|
| `idle` | No active call |
| `outgoing` | Call initiated, waiting for callee |
| `incoming` | Receiving a call (ringing UI) |
| `active` | Call connected, media flowing |
| `ended` | Call terminated |

## iOS CallKit integration

When the app is killed, CallKit is the only way to show an incoming call UI. The flow:

1. Caller's client → `POST /api/calls/ring`
2. Backend sends **direct APNs VoIP push** to iOS devices with a `voipToken` (ES256 JWT, topic `<bundle>.voip`).
3. `PKPushRegistry` delivers the VoIP push → `CanariReportIncomingCall` reports a CallKit call.
4. User answers → writes `pending_call_accept.json` → fires accept deep link.
5. App unlocks → TS store drains `pendingCallAccept` → `CallService` auto-accepts when the matching MLS invite arrives over WS.
6. CallKit session ended on `didBecomeActive` (handed over to in-app WebRTC).

VoIP push tokens are persisted to `voip_token.txt` and registered via `/api/mls/push/register` (`voipToken` field).

## Android incoming call

`CanariFirebaseMessagingService` handles `call_ring` data pushes:

- Channel `canari_calls` (IMPORTANCE_HIGH, ringtone, `setBypassDnd`)
- `NotificationCompat.CallStyle.forIncomingCall` (API 31+)
- Full-screen intent (`USE_FULL_SCREEN_INTENT`)
- `FLAG_INSISTENT` looping ringtone
- 60 s timeout (`setTimeoutAfter`)
- Answer = deep link; decline = local dismiss

## Ring-end (stop ringing)

`POST /api/calls/ring-end` with reason (`answered` / `cancelled` / `ended`) is sent to **all** members including the caller's own devices. Both platforms also arm a local 60 s timeout.

Ordering: `call_ring_end` must be processed **before** the foreground guard — a stale ring must clear even if the user opened the app.

## Sibling device awareness

`GET /api/calls/sibling-status` checks if another device of the same user is already in a call. Used to suppress incoming call UI on inactive devices.

## Key components

| Component | Role |
|---|---|
| `CallUI.svelte` | Full-screen call UI with video grid, controls (mute, video toggle, speaker, hangup) |
| `IncomingCallOverlay.svelte` | Incoming call screen (accept/decline) |
| `CallButton.svelte` | Call initiation button (audio/video) |
| `CallDuration.svelte` | Live call duration display |

## Key services

| Service | Role |
|---|---|
| `CallService.ts` | WebRTC peer connection management, media capture, SFU signaling |
| `CallNotificationService.ts` | Ring/hangup push triggers via chat-delivery-service |

## API endpoints (chat-delivery-service)

| Method | Path | Description |
|---|---|---|
| POST | `/api/calls/initiate` | Verify membership, return LiveKit/LiveKit room token + room ID |
| GET | `/api/calls/room-token` | Get room token for recipient |
| GET | `/api/calls/ice-servers` | Get ICE server configuration (Cloudflare TURN) |
| POST | `/api/calls/presence` | Report device presence in call |
| GET | `/api/calls/sibling-status` | Check sibling device call status |
| POST | `/api/calls/ring` | Fan out incoming-call ring to all group members |
| POST | `/api/calls/ring-end` | Stop the ring everywhere |

## See also

- [`services/call-service.md`](../services/call-service.md) — SFU WebRTC relay
- [`services/chat-delivery.md#calls`](../services/chat-delivery.md#calls) — Backend call endpoints
- [`protocols/mls-protocol.md`](../protocols/mls-protocol.md) — E2E encryption for call signaling
