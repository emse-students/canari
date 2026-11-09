## Decided by the user on 2026-10-22 - what outlives the 48-hour autonomy window

The window itself (2026-10-22 to 2026-10-24: stables without asking, the kill switches, the cleanup
of stale drafts) has ENDED; the release authority is [durable-rules](../durable-rules.md#release-and-ci---cicd)
again. What stands:

- **Incoming share** is erased at sign-out and at account switch, on Android and on the iPhone (lot S4, #2295).
- **Lives on R2 (#2211), decisions O-1 to O-7:** the lead decides following that pull request's recommendations and records EACH decision with its measurement. No visible viewer cap.
- **Store listings:** redone, texts AND images, with FICTIONAL demo accounts on dev and no personal data; the user sees both BEFORE any submission. The lead never changes a data declaration without the user.
- **The phone at-rest key (#2274): the built design stays** - notifications stay complete, the PIN is verified by the server, the hardware key protects the stored data.
- **Lives:** the live key is encrypted at rest under an environment secret. `calls_mode` may be set to `audio` in production by the lead once the stable is deployed and read on both phones, with an immediate notice to the user; `lives_mode` once everything is read, with an announcement.
- **iPhone ring:** until the native ring (PushKit VoIP plus CallKit, #2305, behind its switch) is on, the iPhone call alert is generic ("Appel entrant", no name).
- **Standing reminder from the user:** *"il faut toujours vider le backlog, et assez rapidement avoir les lives et les appels en production"* ([live-production](../frontend/modules/live-production.md), [calls](../frontend/modules/calls.md)).
