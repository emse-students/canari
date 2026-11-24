### Fixed - social-service race specs assumed an outcome the race decides

The refund race specs assumed a fixed number of winners and one refusal wording, and the concurrent slug-derivation spec assumed the cotisation-stem refusal is always logged; each failed intermittently in a full-suite run. They now derive or bound the expected warnings from the outcome. The service was correct. See [testing-methodology](docs/wiki/testing-methodology.md).
