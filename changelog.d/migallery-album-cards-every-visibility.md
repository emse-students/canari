### Fixed - a MiGallery album link shows its card again, private albums included

MiGallery v2.23.1 made `/api/albums/[id]/info` the staff's, so Canari's read key got a 403, silently, and every album link drew the generic MiGallery card. Canari now reads MiGallery's read-scoped `/api/albums/[id]/preview` (title, date, place, wide cover for every visibility) and every fallback branch logs with its status ([chat-delivery](docs/wiki/services/chat-delivery.md#who-carries-the-migallery-key-and-who-does-not)).
