# `archive/` - the rows, and everything that was not an atom

**114 scripts moved here on 2026-09-04, and NOTHING was deleted.** They still run, they are still
in git, and the 14 self-tests `make test-harness` gates are among them and still pass from here.
This is a split by KIND, not a graveyard.

## The split, in one sentence each

| | lives at the harness ROOT | lives HERE |
|---|---|---|
| what it is | an **atom** - one gesture | a **row** - a question composed of gestures |
| what it ends on | a fact about the product | a VERDICT in `results.ndjson` |
| who calls it | a person, or another atom | the campaign |
| example | `login.mjs`, `pin.mjs`, `a1apk.mjs` | `comm17.mjs`, `heal-revoke`, `msg4.mjs` |

The definition of an atom is in [`../atoms.mjs`](../atoms.mjs) and is not restated here: it ends on a
fact rather than a clock, it reads before it acts so a second call is a read, and it addresses the
product structurally rather than by pixel or by wording.

**Why the move.** The rig was 155 files in one flat directory, about twenty of which were gestures.
A session picking it up could not see which was which, and the cost was measured rather than
theorised: `atoms.mjs` records the third `createGroup` being written because the first two were not
findable, and three copies of one gesture is three places for a post-condition to rot. A directory
boundary is the cheapest thing that makes the split visible from `ls`.

## What the move actually changed in these files

**Their imports, and nothing else.** A script here reaches a library that stayed behind by `../`:

```js
import { client, send } from '../chat.mjs';   // was './chat.mjs'
import { watch } from '../watch.mjs';
```

Every relative import in all 155 files was checked to resolve after the move. Three things that
resolve paths had to learn that the rig is no longer one flat directory, and each is a real defect
the move exposed rather than created:

- **`checks.mjs` gained `scriptPath()`** - the manifest names both rows (here) and atoms (root), so
  one resolver knows the two places. A name in neither is an error, because the manifest has then
  drifted from the tree.
- **`gate-selftest.mjs`** matched Makefile lines by BASENAME and walked only `./` imports. A bare
  name no longer identifies a file, and a closure blind to `../` would have reported every gated
  self-test as depending on nothing and passed it for the wrong reason - silent under-reporting,
  which is the worse failure for a gate.
- **The `Makefile`'s `test-harness` recipe** names these by path, so its 14 lines gained `archive/`.

## Running one

Exactly as before, from the harness root - the paths inside them are relative to themselves:

```sh
bun archive/comm17.mjs --only 3
make test-harness            # the 14 gated self-tests, all of which live here
```

## When to take something out of here

When it is being turned into an atom. Moving a row back unchanged is almost never right: if a
gesture inside it is worth reusing, the gesture goes to the root as an atom and the row keeps its
verdict. That is the direction the whole split exists to encourage.
