## P2 - a frame read before a browser kill is called "never read here" on the next cold start

target: 1.7.0

**What is built:** the live seen-cipher mark written at the checkpoint (#1998, `v1.3.0`).

**Measured on 2026-11-14** (TAB-3b, two runs, local estate at `ad2053fc0`, a fresh W1+W2 group): both outage messages arrived exactly once, but the SECOND cold start logged `[History] frame never read here and unreadable for good (secret-reuse); will reconcile` for the frame W1 had read in the first run (`SecretReuseError`: the ratchet had consumed it, so it WAS read here). The mark of a frame read shortly before a hard kill (the process is stopped, no lifecycle event) does not survive to the next load. The reading that closed the entry - no new such line on a cold start after a drain - therefore FAILS; what is owed is the cause (is the mark written only by the checkpoint the kill pre-empted?) and a rerun of TAB-3b reading zero lines.
