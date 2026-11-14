## Reading owed - the `[voice]` line for the SWIPE-CHECK media shown 'Format non supporte' on the Mi 9T

target: 1.7.0

Both media show "Format non supporte / Telecharger" on the Mi 9T while the iPhone lists them as
"[Media]". Unexplained; the swipe half of that report is fixed
([mobile](../frontend/mobile.md#a-modal-closed-by-its-owners-state-left-the-overlay-stack-and-the-tab-swipe-stood-down-2026-10-09)).
**The refusal logs its cause since `v1.3.0` (#2091)**; owed: that
`[voice] ... refused its source` line from the Mi 9T on the conversation, which decides the fix
([chat](../frontend/modules/chat.md#format-non-supporte-names-its-cause-in-the-log-2026-10-18)).
