### Changed - the per-drain checkpoint is measured on the phone, and skipping it is parked as a decision

On the Mi 9T, a full checkpoint costs about 100 times the one decrypt it follows: 49 ms against 0.49 ms at 7.7 MB. New tests show that a state left behind by received frames re-reads them and loses none. Skipping the checkpoint still weakens durability, so it is recorded as a decision for the user and nothing is built ([open-questions](docs/wiki/open-questions.md#decision-owed---may-a-drain-that-only-received-application-frames-skip-its-full-checkpoint-2026-10-13)).
