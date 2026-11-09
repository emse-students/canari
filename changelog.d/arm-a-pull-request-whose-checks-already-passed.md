### Fixed - a pull request marked ready after its CI finished is merged by the chain instead of failing the arming

GitHub refuses to enable auto-merge on a pull request that is already mergeable (#3202: `unstable status`), so the arming run failed and a human had to merge. The step now reads `mergeStateStatus` (CLEAN or UNSTABLE, not a draft) and merges at once, pinned to the judged head and only when GitHub Actions' newest `CI passed` on it is green - those reads are the whole gate, since the App bypasses the ruleset; any other state still fails loudly ([cicd](docs/wiki/cicd.md)).
