### Fixed - the social unit run no longer leaves sockets open at the end

The real-HTTP specs left undrained response bodies and idle connections to the worker, which ended
the run with "A worker process has failed to exit gracefully"; they now read each body and close
their connections at teardown ([roadmap](docs/wiki/roadmap.md), row D068).
