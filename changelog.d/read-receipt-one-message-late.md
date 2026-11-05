### Fixed - a read receipt no longer sits one or two messages before the last one read

A message received live kept its server time only on disk, so until a reload the reader's mark was taken on the author's clock and fell short of what it had read; the shown row now carries it ([chat](docs/wiki/frontend/modules/chat.md)).
