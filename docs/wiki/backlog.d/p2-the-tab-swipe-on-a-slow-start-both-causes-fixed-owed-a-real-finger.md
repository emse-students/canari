## P2 - The tab swipe on a slow start: both causes fixed, owed a real-finger reading (Mi 9T, 2026-10-21)

The owner's "the swipe to the camera does not work every time" was two deterministic classes, the
whole matrix and its evidence in [design-reference](../frontend/design-reference.md#the-swipe-to-the-camera-that-sometimes-did-nothing-two-classes-measured-mi-9t-2026-10-21).
**A** (the 12 px lock sat past Chrome's 8 dp slop, so a first `touchmove` under it left the sequence to
Chrome): the lock is 8 px, shipped in `v1.4.0` (#2179). **B** (a start in Android's left edge is a
system Back): the left-edge exclusion, #2184 in `v1.4.0`, widened to every tab root by #2369 (its
reading is a row of the verification table). Owed: one real-finger reading of slow swipes on the Mi
9T, and class A read on the iPhone, where it is unproven.
