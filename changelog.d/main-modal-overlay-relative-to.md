### A test left calling a removed helper after two merges is repaired

`ModalOverlay.test.ts` kept a call to `relative`, an import #3594 had just removed, while #3556 added the line that used it. Each PR was green on its own and `main` failed `svelte-check` once both were merged. The call is now `relativeTo`, and moving checks into the hooks is in [cicd](docs/wiki/cicd.md).
