## P3 - New-device alerts queue one at a time, never forget a device that has left, and push the full-screen camera down (Mi 9T, 2026-10-28)

On the Mi 9T's bench account, a reinstall surfaced a queue of "Nouvel appareil sur votre compte"
alerts, one per enrolment of that account's other clients (dated 25 Oct 12:15, 12:20, 17:47,
23:13, ...). Read from `NewDeviceBanner.svelte` and `deviceNotices.svelte.ts`, three things, and
none of them is bench-only:

- **One at a time.** The banner draws `pendingDeviceNotices()[0]`, and "Compris" and "Voir mes appareils"
  dismiss that one alone, so N devices added while this one was away cost N taps. "Voir mes appareils"
  opens the list that shows them all, yet it dismisses one.
- **Nothing prunes an alert whose device has since left the account.** A pending alert is
  removed by a dismissal or by "Ce n'est pas moi", never by the device's revocation elsewhere. That
  is unread: whether the queued devices here are still enrolled.
- **The banners sit above the full-screen CanaReels camera and the reel composer.** They take the top
  third of the screen, and the camera's own controls start under them.

Owed: one alert per batch (or "Voir mes appareils" dismisses every pending alert), an alert dropped
when its device is no longer on the account, and the banner hidden or deferred on a full-screen
capture surface. Read on the Mi 9T against the rig build `5c362c0e1`.
