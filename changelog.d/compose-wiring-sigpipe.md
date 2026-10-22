### Fixed - ci: the compose-wiring self-test no longer reports a present key as missing

Under `pipefail`, `grep -q` closed its pipe on the first match and the writer's SIGPIPE failed the pipeline; its pipes now let grep read to the end.
