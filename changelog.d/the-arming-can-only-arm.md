### Changed - the arming step can only arm; the one merge it makes is behind its own reads

`arm-auto-merge.yml` sends GitHub's `enablePullRequestAutoMerge` mutation instead of `gh pr merge --auto`, which merged by itself when a pull request looked mergeable to it ([cicd](docs/wiki/cicd.md#package-1-opening-a-pull-request-ciyml)).
