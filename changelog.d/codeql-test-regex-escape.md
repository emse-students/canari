### Fixed - the Android call-bridge test escapes every regex metacharacter

A test built a pattern escaping only parentheses, which CodeQL reported as incomplete sanitisation
and which kept the nightly alerts report red. See [cicd](docs/wiki/cicd.md).
