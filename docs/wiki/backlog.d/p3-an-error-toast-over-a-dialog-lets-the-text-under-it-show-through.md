## P3 - an error toast over a dialog lets the text under it show through

target: 1.7.1

**Found by:** the toast-over-an-overlay reading, sitting S6 on `1.7.0-alpha.12`, Mi 9T in the dark theme
([readings](../device-verification.md#the-phone-and-web-readings-of-2026-11-18-s6-170-alpha12-live-moderations-last-halves-the-reel-card-overlays-the-birthday-morning)). The cap's error toast ("Une publication contient au maximum 10 pièces jointes.") is drawn
above the new-post composer (`z-index` 310 over 200), but its surface is `bg-red-500/10`
(`ToastContainer.svelte`, the warning one `bg-amber-warn/10`): the dialog's title "Nouvelle publication" reads
through the toast's red text, and both are hard to read. Unchanged since `v1.6.12`, so not a regression.

**The fix:** an opaque surface under the tinted one for the error and warning toasts (a token of
`app.css`), and the same reading on both phones.
