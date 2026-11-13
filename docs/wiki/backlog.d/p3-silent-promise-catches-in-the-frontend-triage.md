## P3 - about a hundred promise rejections in the frontend end in an empty handler: triage owed, no fix yet

target: 1.10.0

**Counted on `main`, 2026-11-12** (`frontend/src`, tests and comment lines excluded): **101**
handlers that take a rejection and return nothing - 72 `.catch(() => {})`, 18
`.catch(() => undefined)`, 11 `.catch(() => null)`. The backend services hold none of these three
shapes. The count is of SHAPES, not of defects: a good part of them are correct. The rule every
task carries is *every swallowed branch logs*; what is owed is to sort the 101 by it, not to
rewrite them in one pass.

```sh
git grep -nE '\.catch\(\(\) => (\{\}|undefined|null)\)' -- frontend/src
```

### The rule that tells one from the other

Ask of each handler: **is it the ONLY reader of this rejection?**

- **A legitimate tail - another reader has the rejection.** The same promise is awaited, returned
  or handled somewhere else, and the empty handler exists only so that a second reference to it
  does not raise an unhandled rejection or break a chain. The shapes: a serialization tail
  (`tail = run.catch(() => undefined)` while the caller awaits `run`), a wait for something
  another path owns (`await inFlight?.catch(() => {})`), a handle kept beside the one that is
  returned. Nothing is lost: leave it, and say so in a comment where the other reader is not on
  the next line.
- **A value, not a silence - the caller reads the answer.** `.catch(() => null)` followed by a
  branch on `null` that logs or reports is a conversion, and the log belongs to that branch. It
  is correct only if the branch exists and says something; and a `null` that means both "absent"
  and "the read failed" is the defect the rule *a status code is an answer, a transport failure
  is not* names.
- **A swallowed failure - nobody else reads it.** The handler is the last place the rejection
  exists: a save, a delete, a lock release, a native call, a navigation. In a best-effort path
  the line is all a loss leaves, so it logs at the level its consequence deserves; and where the
  failure changes what the user should see, it is not best-effort at all.

### How to take it

By file, largest first (`BaseMlsService.ts`, `utils/chat/actions.ts`, `setupMessageHandler.ts`,
`sessionAuth.ts`, `useChannelWorkspaces.svelte.ts` hold about a third). Each pass ends with a
number: how many were tails, how many values, how many now log. A source guard that holds the
count per file from rising is the gate to add with the first pass - written then, when the
legitimate shapes it must allow are known from the code and not guessed here.
