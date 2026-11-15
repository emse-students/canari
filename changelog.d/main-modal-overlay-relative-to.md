### A test left calling a removed helper after two merges is repaired

`ModalOverlay.test.ts` called `relative`, an import #3594 had just removed, while #3556 added the line that used it. Each PR was green on its own, and `main` failed `svelte-check` once both had merged. The call is now `relativeTo`; why `CI passed` cannot see two changes that are each correct is in [cicd](docs/wiki/cicd.md).
