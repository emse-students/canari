## P3 - READ ON THE NEXT 1.7.1 PRE-RELEASE: the chips row of "Nouvelle discussion" holds its place

target: 1.7.1

**Fixed in code.** The chips appeared with the first pick and pushed the recent list down under the finger ([readings](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha10-both-phones-and-the-rig)). The row (`SidebarNewChatModal`, `new-chat-chips-slot`) now has one height from the opening - a hint before any pick - and is a single line that scrolls sideways instead of wrapping, so a chip never moves a row ([chat](../frontend/modules/chat.md#one-new-discussion-panel)).

**The reading that closes it:** on the iPhone 12, two recent people chosen in a row: the second tap lands on the person under the finger, with the list unmoved.
