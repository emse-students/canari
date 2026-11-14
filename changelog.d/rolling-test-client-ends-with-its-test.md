### Fixed - the rolling-deploy test's load client no longer outlives a failed run

A failed `deploy-rolling.test.sh` removed its directory without stopping its client. The client then waited for a stop file that never came, and kept every refused connection in memory: three leaked clients held 13 GB on a workstation. The client now ends when its directory is gone and keeps only the 20 failures it prints, and the cleanup stops it ([cicd](docs/wiki/cicd.md)).
