### Changed - the build jobs read their estate's secrets from its GitHub environment

The repository hit GitHub's cap of 100 secrets. The web, Android and iOS builds now declare the
environment of their estate and read one set of names, the release refuses a repository copy of
those names, and the rendered `.env` is private to its owner
([cicd](docs/wiki/cicd.md#where-a-secret-lives-and-why)).
