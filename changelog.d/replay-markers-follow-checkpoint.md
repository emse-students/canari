### Fixed - a history replay's progress markers no longer land before the checkpoint they claim to follow

A replay's stream cursor now waits for a checkpoint that started after the replay and holds its state, and the seen-ciphertext set is written by the checkpoint alone, so a live commit marked mid-seal can no longer become durable ahead of its epoch ([mls-desync-prevention](docs/wiki/protocols/mls-desync-prevention.md#a-history-replays-markers-wait-for-the-checkpoint-that-holds-it-2026-10-21)).
