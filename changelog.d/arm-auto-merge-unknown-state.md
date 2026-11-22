### Fixed - a ready, green pull request is no longer stranded when two merges land together

After the base moved, GitHub read the merge state `UNKNOWN` (not computed yet) and `arm-auto-merge` failed (#3945); it now merges on `UNKNOWN` under the same strict reads, GitHub refusing a real conflict itself
([cicd](docs/wiki/cicd.md#package-1-opening-a-pull-request-ciyml)).
