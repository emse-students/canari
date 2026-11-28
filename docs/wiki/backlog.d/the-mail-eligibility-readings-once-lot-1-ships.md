## The mail eligibility readings, owed once lot 1 and its claim ship: real MiConnect sign-ins and the "Activer le mail" button (lead, 2026-11-28)

target: 1.10.0

**Not a `Reading owed` entry yet, on purpose**: a reading targets the earliest version, and none of
this can be read before lot 1 merges and the stable that applies its blueprint ships - both planned
in `1.10.0`. Once that stable is out, this entry becomes a `Reading owed - ` entry in the next
version.

**What is built** (lot 1, #4198; [eligibility](../mail-client-transport.md#eligibility)): MiConnect's
`school_mail` claim for CAS-created accounts on `etu.emse.fr` and `emse.fr`, stored by core-service as
`users."mailClass"` only from a sign-in GRANTED the scope, and the device's copy of the address for the
mail sign-in's prefill. The blueprint reaches MiConnect at a stable; until then every class is NULL and
the relay refuses everyone (4005), which is the expected state.

**The readings that close it**, after the stable that applies the blueprint, on the estate it applied to:

1. **A CAS student account** signs in from a client that asks for the scope: its `mailClass` is
   `student`, and the device holds its `@etu.emse.fr` address.
2. **A CAS staff account** the same: `mailClass` is `staff`.
3. **An older client** (one that does not ask for `school_mail`) signs in on an account with a class:
   the class is LEFT as stored, never cleared.
4. **An Alumni-created account** signs in: its `mailClass` stays NULL, and no address reaches the device.
5. **Lot 3's "Activer le mail" button** (#4211, `startSchoolMailActivation`), on an account signed in
   before the stable (`schoolMailAddress()` is `null`): one tap through MiConnect, the class stored, the
   address on the device, back where it started.

Read on dev first if the blueprint is applied there; the production reading closes the entry.
