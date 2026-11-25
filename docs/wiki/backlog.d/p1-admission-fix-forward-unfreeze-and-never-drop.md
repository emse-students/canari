## P1 - the admission fix-forward, slices 4 and 5: an unfreeze path, no frame ever dropped, then the refusal re-armed behind its gate

target: 1.10.0

Slices 4 and 5 of [the admission fix-forward](../protocols/admission-fix-forward.md#the-slices-in-order),
planned 2026-11-25. They come after slice 3 ([the emission side](p1-admission-fix-forward-the-emission-side.md),
`1.9.0`) because the re-arm needs that slice's measurement at zero, and `1.10.0` is the version after
it.

4. **An unfreeze path.** Whatever a refusal leaves is lifted by a person (a member's Add) or by a fact,
   per account, never stored device-wide and never permanent. Designed on the
   [design page](../protocols/admission-fix-forward.md) first. *Size: three to five days.*
5. **Never drop frames, then the re-arm.** A refusal may stop a recovery; it may not ACK a
   conversation's messages away. It must hold against a member who enrols a second account to freeze
   a conversation on purpose, and against an older client that merges the commit while its peers
   refuse it (the split): both need `minClientVersion` raised to the build that refuses. The
   refusal is re-armed only once [the gate](../protocols/admission-fix-forward.md#the-gate-that-lifts-the-refusal)
   reads zero. *Size: about one week, then a store cycle for the floor, then the re-arm behind its
   own reading.*
