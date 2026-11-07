### Fixed - a call from one service to another is no longer reset while its peer is replaced

Services called each other by Docker's DNS, which still names a retiring replica; they now call a pinned nginx, `mesh`, that every deploy takes the replica out of before it stops, and a compose value or an unset code default naming a peer directly is refused ([cicd](docs/wiki/cicd.md#service-to-service-calls-go-through-the-mesh)).
