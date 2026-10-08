### Added - docker-prune can remove unused release images, by allowlist

`prune.py --remove-releases` removes `ghcr.io/emse-students/canari/*:v*` images beyond the newest N that no container references; dry-run prints the plan ([README](infrastructure/docker-prune/README.md#release-images---an-allowlist-by-name-and-three-guards)).
