## Reading owed - a left-edge swipe over a `Modal` or sheet on the iPhone closes it, and over a gate does nothing

target: 1.7.0

**What is built:** a left-edge swipe over a `Modal` or sheet on the iPhone closes it, and over a gate does nothing (`Modal.svelte` carries `swipeBack` when narrow and `dismissible`, `Modal.dismissal.svelte.test.ts`; [reels-in-chat](../frontend/modules/reels-in-chat.md#the-iphone-12-reading-of-v129-alpha2---the-edge-swipe-is-the-ios-back-2026-10-16))

**The reading that closes it:** on the iPhone 12: one swipe over a sheet opened from a conversation (it closes, the conversation stays) and one over a gate (nothing moves)
