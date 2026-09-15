# Cold start - measuring launch to the fingerprint prompt

**What it answers:** how long a real Android handset takes between `am start` and the
`BiometricPrompt` appearing, and - when that number is too big - **which work is holding it**.

**Why it is here and not in a gate.** An APK embeds its frontend (`frontendDist: "../build"`), so
no deploy reaches one: a change to the launch path is only observable on a build of that tree,
installed on a phone. Everything else about the launch - the WebView booting, the keystore, the
prompt - exists nowhere else either. See
[device-verification](../../docs/wiki/device-verification.md).

```sh
bun tools/cold-start/coldstart.mjs 3        # the NUMBER: three cold starts, launch -> prompt
bun tools/cold-start/launch-trace.mjs --heartbeat   # the CAUSE: one launch, every clock on one axis
```

`ANDROID_SERIAL` picks the handset; with exactly one attached it is inferred, and with several the
tools refuse rather than guess - a measurement attributed to the wrong phone is worse than none.

## The three instruments, and the question each one can answer

|                                    | answers                                       | blind to                 |
| ---------------------------------- | --------------------------------------------- | ------------------------ |
| `coldstart.mjs`                    | the number, over N runs                       | everything about why     |
| `launch-trace.mjs`                 | WHEN each console line printed, in wall clock | work that prints nothing |
| `heartbeat.mjs` (or `--heartbeat`) | main-thread blocks, to 50 ms                  | work that yields         |

**The heartbeat is the one that found the defect of 2026-09-15, and the others could not.** The
resource timeline said the network was finished at 1.5 s of a 4.9 - 5.7 s launch. Airplane mode
still left 4.3 s - it removes the _network_, not the ~45 _requests_, so it bounds the network's
share (~1.2 s) and isolates nothing. The heartbeat named it in one run: **a single block of
2 731 ms, ending 51 ms before the prompt**. The prompt was never slow; a `BiometricPrompt` is
raised by an `invoke`, so its IPC message was queued behind the block. The cause was `mls.bin`
crossing the Tauri bridge twice as a JSON array of per-byte numbers - the account of it is in
[mobile](../../docs/wiki/frontend/mobile.md) and `CHANGELOG.md`.

## Two facts about clocks, which is what makes the correlation possible

- **`performance.timeOrigin` is an absolute epoch**, and so is a `logcat -v time` timestamp. A page
  offset and a system-server line therefore go on ONE axis with no guesswork.
- **A WebView keeps no console buffer**: a line is only observable by an observer already attached
  when it printed, which is why `launch-trace.mjs` polls for the devtools socket instead of
  sleeping a guessed amount. `performance.getEntriesByType('resource')`, by contrast, retains what
  happened _before_ the attach - so the network half survives a late attach and the console half
  does not.

## The precondition, which is not ambient

**A signed-in handset with an enrolled fingerprint.** The number is launch -> _prompt_, and a
client with no session to unlock never raises one - so the run fails rather than reporting a fast
launch.

`coldstart.mjs` now says WHICH precondition failed instead of leaving it to the reader, because on
2026-09-15 `no bracket - START=true PROMPT=false` cost six manual `adb` commands to resolve into
"the phone is signed out". It reads the discriminator out of the logcat dump it already holds: the
process being gone means a CRASH; no `canAuthenticate` at all means the app never reached the
unlock decision; a `PreAuthInfo AuthenticatorStatus` other than `1` means the system server would
have refused the prompt (the code is printed, not translated - only `1` has been observed against a
handset known to be enrolled); and `canAuthenticate` answering OK while the app still declines to
prompt means **there is no session**, which is what a refused refresh credential looks like from
here (`PIN prompt declined - refresh credential already proven dead`).

None of those improves by being re-measured, so the tool stops at the first one instead of spending
23 s a run to repeat itself, and leaves the app RUNNING in the state that failed.

## What the numbers mean

**The prompt is never answered.** The app is force-stopped between runs, so every run is genuinely
cold and no unlocked session leaks into the next. A run that produces no bracket is a FAILED
measurement and exits non-zero - notably on a device whose account has no biometric enrolment,
which raises no prompt at all and must never be read as a fast launch.

The target is **under 1 s all-in** (user, 2026-09-15). The open items and what has already been
refuted are in [backlog](../../docs/wiki/backlog.md).
