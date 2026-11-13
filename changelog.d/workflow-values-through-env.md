### Changed - every value a workflow script uses reaches it through `env:`

Workflow and composite-action scripts read inputs, event fields, outputs and secrets as shell
variables bound in `env:`, and a test fails on an expression written inside a script
([cicd](docs/wiki/cicd.md#a-value-reaches-a-workflow-script-through-env-never-written-into-its-text-2026-11-12)).
