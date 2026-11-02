### Changed - every `@nestjs` package is at 12.3.2 in all four services, and four CodeQL alerts are fixed

The five conflicting Dependabot bumps are replaced by one aligned change; the CodeQL findings (a promise compared by identity, a regex that always matches, a useless test write) are rewritten rather than dismissed. See [cicd](docs/wiki/cicd.md#dependency-updates-and-the-auto-merge-that-ships-them).
