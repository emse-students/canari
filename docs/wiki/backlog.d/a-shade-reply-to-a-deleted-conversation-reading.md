## The Mi 9T reading of a shade reply to a deleted conversation is owed

target: 1.8.4

_2026-11-28: moved to 1.8.4 when 1.8.3 shipped._

Built 2026-11-26: a conversation the member deleted is recorded (`deleted_conversations`), and a reply
typed in the notification shade for it is adopted as a failed bubble with Delete in a recreated
`removed` conversation ([mobile](../frontend/mobile.md)), where it used to
stay native for good. Owner decision of 2026-11-22 ([decisions](../decisions/owner-decisions-of-2026-11-22.md), item 7).

**Closing reading.** On the Mi 9T: kill the app, receive a message, type a reply in the shade WITHOUT
sending it from the background (airplane mode), delete the conversation in the app before the page adopts
the line, then return: the conversation is back as "Deleted conversation" with the reply failed and
Delete working. A conversation deleted before this build leaves no mark and its line still waits.
