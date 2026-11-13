## Reading owed - one foreground ring on the iPhone, no OS banner over the in-app ring

target: 1.7.0

CALL-OS-BANNER: on the iPhone a foreground ring showed an "Appel entrant" OS banner over the
full-screen ring. The web's own local notification is now deferred while the page is visible
([calls](../frontend/modules/calls.md#the-bar-is-never-under-a-layer-call-bar-covered-2026-10-19)).
Owed: one foreground ring on the iPhone. If a banner still shows, the two native candidates are
(a) the notification plugin's own `UNUserNotificationCenter` delegate presenting in the foreground
if it replaced `CanariNotificationDelegate` - it DID, on every launch until 2026-11-01, when the slot
was taken back for Canari at launch ([mobile](../frontend/mobile.md#one-notification-delegate-and-a-tap-that-waits-for-the-page-2026-11-01));
re-read the ring on a build carrying that (`CanariNotificationDelegate` answers `UNNotificationPresentationOptionNone`
in the foreground, `canari_push.mm`), and (b) the server's ring push (`calls.service.ts`:
VoIP -> CallKit, or the FCM alert for a device without a VoIP token) reaching a device whose app is
on screen - a CallKit report cannot be skipped for a VoIP push, so that half is a server question
(do not ring a device whose socket is live and foreground). Read the log first: the `[NOTIF]` line
says whether the web path ran.

---
