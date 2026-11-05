## P3 - `push_context.json` (user and device) is mirrored to the App Group only at activation and resignation

An account switch in the foreground followed by a foreground kill would pair account B's state with
A's push context, so the extension shows a generic banner. This predates #3040, which made `mls.bin`
follow every write; the context should follow the same rule: what an extension reads is written at
the mutation, never at a lifecycle event ([durable-rules](../durable-rules.md)).
