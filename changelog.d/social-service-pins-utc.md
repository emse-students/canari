### Changed - social-service, core-service and chat-delivery-service pin `TZ=UTC`, and their Postgres session zone

Zone-less timestamps are read in the process zone, so the anonymous week cut and the XLSX dates were
right only while the base image happened to run UTC; the images, the compose files and the connection
now say it, and a test holds it
([social-service](docs/wiki/services/social-service.md#environment-variables)).
