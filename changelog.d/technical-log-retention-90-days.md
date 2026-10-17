### Fixed - the privacy policy's 90 days on technical logs, enforced where this repository can

The deploy-log archive now keeps 30 days of each log for 30 days, and a daily job prunes it and goes red on any live container log older than 60 days; the host-level logs are a request to the host operator ([logging](docs/wiki/infrastructure/logging.md#the-90-day-ceiling-2026-10-16)).
