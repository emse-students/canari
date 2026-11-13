## P3 - on iOS the launch's native push refresh races `/register`, which mints a new secret every call: 13 `[PUSH_SECRET] rejected reason=mismatch` a day (production sweep, 2026-11-13)

**What the sweep read.** 13 `[PUSH_SECRET] rejected ... reason=mismatch` a day, from 10 iOS devices
and no Android one (`guards/push-secret.guard.ts`). Each is a native call made at launch with the
secret the previous `/register` handed out, landing after a newer `/register` has replaced the stored
hash: `POST /mls/push/register` mints a fresh `rawSecret` on EVERY call and overwrites the hash, so
two writers starting at launch - the native token refresh (`CanariPersistFcmToken` /
`CanariPersistVoipToken` -> `refresh-token`, `canari_push.mm`) and the WebView's registration - race,
and the loser presents a dead secret.

**Harmless today, which is why it is P3.** The registration that won re-sends the token itself, so
the server ends up with the right token and the right secret; the rejected call costs one request and
one WARN. But the WARN is noise every day (CLAUDE.md, "NOISE IS NEVER ACCEPTABLE"), and
[mobile](../frontend/mobile.md#the-push-secret-has-two-homes-and-the-file-is-always-the-newer-one)
says the mismatch family was fixed (2026-10-12: the App Group copy written with the handoff file, the
login's double registration joined into one) - that fix closed the NSE half, not this launch race, and
the page must say so when this closes.

**What would close it** - one of two, decided before building:

1. **No rotation when nothing changed.** `/register` keeps the stored secret when the device and the
   session are the ones it was minted for (a durable fact: the row already names both), and mints only
   on a new device, a new session or an explicit rotation. The race then has no loser. Needs the
   threat check that a secret surviving a re-register is not a weaker secret (it is bound to the same
   session either way).
2. **No overlap.** The native launch refresh waits for the WebView's registration of this launch (or
   is skipped when that registration will carry the same token), so exactly one writer runs.

**Proven by** a server spec (two registrations of one device and session return the same secret, a new
session gets a new one) or a native ordering spec, and one production reading after the stable:
`grep -c 'reason=mismatch'` over a day reads 0 on iOS.
