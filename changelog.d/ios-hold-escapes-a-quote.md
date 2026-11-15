### Fixed

- The iPhone bench's `hold` escapes a quote in the label it looks for (it wrote it back unescaped, and the lint warning failed the harness gate of every pull request); the gate now runs on any change under `tools/`, which is what it lints ([cicd](docs/wiki/cicd.md)).
