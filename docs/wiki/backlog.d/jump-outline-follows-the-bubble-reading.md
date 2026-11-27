## P3 - read the jump outline on the web and both phones: it follows the bubble

target: 1.8.3

The accent outline of a message reached by a jump (replied-to chip, pinned banner, poll shortcut, search hit) is drawn on the bubble element, with its own radius
([chat](../frontend/modules/chat.md#the-jump-outline-follows-the-bubble-2026-11-26)). The reading that
closes this entry, on web desktop, the Mi 9T and the iPhone 12, light and dark: jump to a text bubble
(single, first, middle and last of a group, own and peer), a captioned photo, a photo alone, a poll and
a reply (the quoted chip is NOT outlined, only the bubble). PASS when the outline hugs the rounded
corners everywhere and never draws a rectangle around the "vous a repondu" header. Delete this file on PASS.

First reading, 2026-11-27, web, dev 1.8.3-alpha.1, both themes: every case PASSED except a captioned photo that had arrived live, which showed NO outline - its arrival animation (`bubbleInAfterGlide`) replaced the outline's on the same element. Fixed by composing the two in one `animation` list (`app.css`, `.motion-bubble-in.chat-message-jump-highlight`). The reading stays owed on the next alpha, that case first.
