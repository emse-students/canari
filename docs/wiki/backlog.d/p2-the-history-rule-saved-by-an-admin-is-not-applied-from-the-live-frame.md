## P2 - the history rule saved by an admin is not applied from the live frame

target: 1.9.0

Found by COMM-12 on `1.5.0-alpha.1` (2026-10-27), and never worked: the admin's card resets to the old rule right after a `200` save, and the rule applies at the next listing. The server publishes `workspace.updated` with `historyVisibility`, but `channelEventHandler.ts:276-283` forwards only `workspaceId`, `imageMediaId` and `channelsReordered`, so `handleWorkspaceUpdated` never receives it; the frame replaces the sidebar entry with the old rule a millisecond after the save, and the panel re-reads it. A post-stable chantier: the fix turns on a path that has never run live.
