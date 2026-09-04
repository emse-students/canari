# `ecosystem-shape` - the only thing that reads all four repositories at once

```sh
bun tools/ecosystem-shape/shape.mjs
```

Exit 0 means the four GitHub repositories of this ecosystem still have the same CI/CD shape and
nothing in any of them is dead. Exit 1 names every claim that has stopped being true.

## Why it exists

The four repositories - **canari**, **Sky**, **MiGallery**, **refonte-portail-etu** - were converged
onto one delivery model on 2026-09-04: four visible workflows, two called libraries, one arming
mechanism, one audit classifier, one release gate. Every part of that is a claim somebody can
quietly break in ONE repository without breaking a single test, because **each repository's CI only
ever looks at its own tree**. Nothing else in this estate can see across them.

That is the whole gap this fills. It is the only place the word "homogeneous" is checked rather than
asserted in prose, and it caught two silent forks the day it was written: `arm-auto-merge.yml`
naming a deprecated input in three repositories out of four, and Sky's copy explaining that input
with a deploy trigger that had been deleted.

## What it asserts

| # | Claim |
|---|---|
| 1 | Exactly the expected workflow files - **both directions**. A missing one is a capability a repository lost; an extra one is what the user asked to stop (*"ca inonde la console github"*). |
| 2 | **Nothing deploys on a push.** No job reachable from `push`, `workflow_run`, `pull_request`, `pull_request_target` or `schedule` may reach a self-hosted runner or call `deploy.yml`. |
| 3 | No `workflow_call` trigger without a caller in the same repository. |
| 4 | No workflow file that can never run - no trigger of its own AND no caller. |
| 5 | No `.github/scripts/*.sh` that no workflow, script or `Makefile` names. |
| 6 | The shared files are byte-identical where they are meant to be (see below). |

`scheduled.yml` is the one exemption in check 2: it takes reports **on** the production box, which is
a fact reachable nowhere else, and it ships nothing.

## Where the four are allowed to differ, and why

Homogeneity is not sameness, and the script says which is which rather than flattening both.

- **Canari has two extra libraries**, `android.yml` and `ios.yml`. It is the only one that ships to
  two app stores.
- **`release-preflight.sh` is compared across the three siblings only.** Canari's asks FIVE
  questions where theirs ask three: `dev.canari-emse.fr` must already have served the commit, and
  `store/whats-new.txt` must name the version. Making five identical to three would delete a gate;
  making three identical to five would invent one. Canari is excluded **by name**, so the exception
  is visible in the output instead of being an absence nobody notices.
- **`arm-auto-merge.yml` is compared twice, and the two answers mean different things.** Its YAML is
  identical in all four and that is the property that must never fork. Its prose is identical in the
  three siblings and longer in Canari, whose copy cites the two pull requests the behaviour was
  measured on **there** (#329, #330). Copying a measurement into three repositories that never made
  it would be an invention.

## What it is not

**It is not a gate, and it is deliberately wired into no pipeline.** It needs the four repositories
checked out side by side, which no runner has. Run it by hand after touching anything under
`.github/` in any of them.

By default it looks for the four checkouts as siblings of this one. Override with:

```sh
CANARI_ECOSYSTEM_ROOT=/path/to/parent bun tools/ecosystem-shape/shape.mjs
```
