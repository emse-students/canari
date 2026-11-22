## P2 - an Android blind salon banner `held=true` with the seed frame attached (2026-11-17)

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](owner-decisions-of-2026-11-17.md))._

**What is known.** On production, 2026-11-14, one `[PUSH_BLIND] platform=android missing=seed
held=true refused=none` line among eight (the rest iOS, explained and fixed by
[channel-encryption section 27](../protocols/channel-encryption.md#27-the-iphone-held-two-seed-mirrors-and-the-one-without-the-extensions-seeds-won---fixed-2026-11-17)).
Section 27's cause cannot reach Android, which always kept ONE mirror file. `held=true` says the
frame waited for a seed push that would redraw it; whether it was redrawn, and why the frame on the
push did not yield the seed (refused at an epoch held, catch-up insufficient, key group absent, lock
timeout), the server line cannot say. One candidate, unverified: the foreground applied the key
group's frame (consuming its MLS secret) just before the push service tried the copy on the push,
and mirrored the seed after it; the foreground's mirror write does not drain the held registry.

**Owed.** Read the next such line's phone: the in-app export's `[NATIVE_PUSH] ... openSeedFrame`
and `SeedFrameLadder` lines name the branch. Nothing is built before that line is read; then the
branch it names is fixed with a test that fails first.
