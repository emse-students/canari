## P3 - READ ON THE NEXT 1.7.1 PRE-RELEASE: the error toast over a dialog is opaque

target: 1.7.1

**Fixed in code.** The error and warning toasts drew `bg-red-500/10` and `bg-amber-warn/10`, so the new-post composer's title read through the red text ([readings](../device-verification.md#the-phone-and-web-readings-of-2026-11-18-s6-170-alpha12-live-moderations-last-halves-the-reel-card-overlays-the-birthday-morning)). They now use the opaque banner surfaces (`bg-banner-danger-soft`, a new `app.css` token over `--banner-danger-bg`, and `bg-banner-warn`).

**The reading that closes it:** the 11th attachment's cap toast over "Nouvelle publication" on the Mi 9T in the dark theme and on the iPhone, nothing readable through it.
