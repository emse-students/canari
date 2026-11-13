### Fixed - the harness self-test reads the side panel whatever its attribute order

#3434 put a `style:` directive before the class on the side panel's `<aside>`, and the self-test
required the class first, so it failed on every pull request ([cicd](docs/wiki/cicd.md)).
