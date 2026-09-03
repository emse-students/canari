# Store listing content

Text the app stores publish, written by a human and read by the release chain. Not code, and
deliberately **not** under `frontend/src-tauri/`.

| File | Who reads it |
|---|---|
| `whats-new.txt` | `tools/app-store/submit.mjs` writes it into every App Store localization; `.github/scripts/release-preflight.sh` refuses a stable release whose first line does not name the version being released |

## Why it is here and not in `src-tauri/store/`

It was there for one afternoon. Everything under `frontend/src-tauri/` is an input to the
`Frontend Native (Tauri)` CI job, so editing a text file the compiler never reads cost a **3m40s
Rust build** on every release. Release notes change on every single stable release, which is
exactly the wrong thing to hang a Rust compile on.

The general shape, which is worth remembering before adding any file to a crate's tree: **a path
filter answers about a DIRECTORY, not about a file type**, so content parked inside a compiled
tree inherits that tree's whole build.

## The contract for `whats-new.txt`

First line `version: X.Y.Z`, then the notes, at most 4000 characters (Apple's limit, enforced by
the API rather than truncated).

```
version: 0.16.0
Ce qui change pour la personne qui utilise l'application, en francais.
```

**The version marker is the point, not bureaucracy.** Apple requires release notes and refuses a
submission without them, so their absence has to be refused somewhere - but a check that only asks
"is the file non-empty" passes for ever on notes nobody updated, and the store then publishes the
previous release's text. A file cannot be asked when it was last *meant*. Naming the version makes
the staleness impossible instead of reported.

**The version bump deliberately does not rewrite that line.** A marker the machine maintains is
only ever in step with itself.

`node tools/app-store/submit.mjs --check-notes` with `MARKETING_VERSION` set is the whole rule, and
it is the same code the release preflight runs - so there is one implementation and nothing to
drift.
