### Fixed - The calendar PDF draws what its preview shows

The title and weekday row came out in Fredoka instead of Leckerli One and Chewy, without their
accent shadow, and the "Vacances" stamp lay flat: the font picker matched a fallback, the raster
pass stripped every shadow, and the vector layer ignored rotation ([calendar](docs/wiki/frontend/modules/calendar.md#the-pdf-and-its-preview-diverged-three-ways-2026-09-27)).
