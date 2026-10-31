### Fixed - the dependency ceiling reads the base branch, and only a proven-stateless image may cross a major unattended

#2742 (`postgres 16 -> 18` for the identity provider) was held only because the ceiling's own self-test failed, and on the merge ref the check would have read the new pin and passed. The job now checks out the base, and which images may cross a major is an allowlist ([cicd](docs/wiki/cicd.md#a-major-bump-of-a-data-store-is-refused-and-which-images-may-cross-a-major-is-an-allowlist-2742-2026-10-31)).
