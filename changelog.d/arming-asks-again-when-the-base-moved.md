### Fixed - a pull request whose base moved while it was being armed is asked again

`arm-auto-merge.yml` reads the tip of the base before and after each attempt and retries, four times at most, only when it changed; any other refusal fails once and names what was read ([cicd](docs/wiki/cicd.md#package-1-opening-a-pull-request-ciyml)).
