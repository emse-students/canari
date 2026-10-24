### Changed - association image URLs are checked against an allowlist

The service accepts only an https URL or an uploaded media reference for an association logo (migration `106` aligns stored rows), and the export sheets escape every value they interpolate ([associations](docs/wiki/frontend/modules/associations.md)).
