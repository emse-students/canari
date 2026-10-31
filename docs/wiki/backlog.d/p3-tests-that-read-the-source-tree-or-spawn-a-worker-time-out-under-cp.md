## P3 - Tests that read the source tree or spawn a worker time out under CPU load (2026-10-28)

Tests that read the source tree or spawn a worker hit vitest's 5 s default when the machine is
loaded: in a whole-suite local run (the CPU at 97 %), `environment.test.ts`,
`globalChatSingleton.importCycle.test.ts`, `encryption.worker.test.ts`,
`ChatArea.entryWindow.svelte.test.ts` and `graine/distributionGroup.test.ts` timed out, and each
passed alone. CI was not hit. Give them an explicit timeout sized to their measured cost.
